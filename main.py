"""
SmartQuiz – das Smart-Solutions-Quiz (Basis: QuizKnaller)
Ein Multiplayer-Quiz das einschlägt!
"""

from __future__ import annotations

import sys

# Workaround: drop known system injection paths that can shadow venv packages
# Be conservative: only remove Nix paths that point to site-packages, keep stdlib entries.
def _should_keep_path(p: str) -> bool:
    if "/nix/store/" in p and "site-packages" in p:
        return False
    return True

sys.path = [p for p in sys.path if _should_keep_path(p)]

import asyncio
import hashlib
import io
import json
import mimetypes
import os
import re
import secrets
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import qrcode
import socketio
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

import database as db

# Create Socket.IO server
# Erlaubte Browser-Origins für Socket.IO (Produktion: CORS_ORIGINS=https://quiz.benjamin-stahl.de).
# Lokal ohne Variable: alles erlaubt.
_cors = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]
sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins=_cors or "*",
    max_http_buffer_size=300_000,  # größte Nachricht (ein eigenes Quiz) – Standard wäre 1 MB
)
@asynccontextmanager
async def lifespan(_app):
    """Beim Start alte Spiele (> 24 h) aus der Datenbank löschen."""
    deleted = db.cleanup_old_games(24)
    if deleted > 0:
        print(f"Cleaned up {deleted} old games")
    yield


app = FastAPI(title="SmartQuiz", description="Das Smart-Solutions-Quiz", lifespan=lifespan)
socket_app = socketio.ASGIApp(sio, other_asgi_app=app)

# Initialize database
db.init_db()

# In-memory cache for active games (with database persistence)
games: dict[str, dict] = {}

# Track pending host disconnection cleanup tasks
host_disconnect_tasks: dict[str, asyncio.Task] = {}

# Configuration
HOST_RECONNECT_GRACE_PERIOD = 60  # seconds to wait before ending game after host disconnect
READING_SPEED_WPM = 150  # words per minute for reading phase (lower = more time)
MIN_READING_TIME = 2  # minimum seconds for reading phase
MAX_READING_TIME = 8  # maximum seconds for reading phase
DEFAULT_INACTIVITY_THRESHOLD = 3  # default number of questions without answer to be considered inactive
MIN_TIME_LIMIT = 5  # minimum time limit for questions in seconds
MAX_TIME_LIMIT = 120  # maximum time limit for questions in seconds

# Obergrenzen gegen Speicher-/Datenbank-Flutung (Spiele lassen sich ohne Login anlegen)
MAX_QUESTIONS = 200
MAX_TITLE_LENGTH = 100
MAX_QUESTION_LENGTH = 300
MAX_ANSWER_LENGTH = 150
MAX_ACTIVE_GAMES = 300
MAX_PLAYERS_PER_GAME = 200
MAX_TEAMS = 20
GAME_CODE_RE = re.compile(r"^[A-Z0-9]{6}$")

# Load quiz data
QUIZ_FILE = Path(__file__).parent / "quizzes.json"


def load_quizzes() -> list[dict]:
    if QUIZ_FILE.exists():
        with open(QUIZ_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return []


def calculate_reading_time(text: str) -> float:
    """Calculate reading time based on word count."""
    word_count = len(text.split())
    # Calculate time in seconds based on words per minute
    reading_time = (word_count / READING_SPEED_WPM) * 60
    # Clamp to min/max bounds
    return max(MIN_READING_TIME, min(MAX_READING_TIME, reading_time))


def generate_game_code() -> str:
    """Generate a 6-character game code that is not in use yet."""
    while True:
        code = str(uuid.uuid4())[:6].upper()
        if code not in games and not db.get_game(code):
            return code


MAX_NAME_LENGTH = 20
RUNNING_STATES = ("starting", "reading", "question")


def _is_int(value) -> bool:
    """True for real ints (bool is a subclass of int in Python, exclude it)."""
    return isinstance(value, int) and not isinstance(value, bool)


def validate_quiz(quiz) -> str | None:
    """Validate a custom quiz. Returns an error message or None if valid."""
    if (not isinstance(quiz, dict) or
        not isinstance(quiz.get("title"), str) or
        not quiz["title"].strip() or
        len(quiz["title"]) > MAX_TITLE_LENGTH or
        not isinstance(quiz.get("questions"), list) or
        not quiz["questions"]):
        return "Ungültiges Quiz-Format"
    if len(quiz["questions"]) > MAX_QUESTIONS:
        return f"Zu viele Fragen (maximal {MAX_QUESTIONS})"

    for i, q in enumerate(quiz["questions"]):
        if (not isinstance(q, dict) or
            not isinstance(q.get("question"), str) or
            not q["question"].strip() or
            len(q["question"]) > MAX_QUESTION_LENGTH or
            not isinstance(q.get("answers"), list) or
            len(q["answers"]) != 4 or
            not all(isinstance(a, str) and a.strip() and len(a) <= MAX_ANSWER_LENGTH for a in q["answers"]) or
            not _is_int(q.get("correct")) or
            not 0 <= q["correct"] <= 3 or
            not _is_int(q.get("time_limit")) or
            not MIN_TIME_LIMIT <= q["time_limit"] <= MAX_TIME_LIMIT):
            return f"Ungültiges Fragen-Format bei Frage {i + 1}"
    return None


def get_builtin_quiz(quiz_id) -> dict | None:
    quizzes = load_quizzes()
    if not _is_int(quiz_id) or not 0 <= quiz_id < len(quizzes):
        return None
    return quizzes[quiz_id]


def new_game_state(host_sid: str, quiz: dict, host_token: str) -> dict:
    return {
        "host_sid": host_sid,
        "host_token": host_token,
        "quiz": quiz,
        "players": {},
        "current_question": -1,
        "state": "lobby",  # lobby, starting, reading, question, results, ended
        "answers": {},
        "question_start_time": None,
        "team_mode": False,
        "teams": [],
        "top_n_players": 3,
        "auto_remove_inactive": False,
        "inactivity_threshold": DEFAULT_INACTIVITY_THRESHOLD,
        "answer_history": {},  # Track which questions each player answered
        "last_results": None,   # cached show_results payload for host reconnects
        "final_results": None,  # cached game_ended payload for host reconnects
    }


def player_list(game: dict) -> list[dict]:
    return [{"name": p["name"], "score": p["score"], "team": p["team"]} for p in game["players"].values()]


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    return response


mimetypes.add_type("application/manifest+json", ".webmanifest")

# Serve static files
static_path = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=static_path), name="static")


# Cache-Busting: Cloudflare cacht /static/* – ohne Versionsnummer bekämen Besucher nach einem Update
# neue HTML-Seiten mit altem CSS/JS. Die Version ist ein Hash über alle CSS/JS-Dateien und ändert sich
# automatisch bei jeder Änderung; die HTML-Seiten selbst werden nie gecacht.
def _asset_version() -> str:
    digest = hashlib.sha256()
    for f in sorted(static_path.glob("*")):
        if f.suffix in (".css", ".js"):
            digest.update(f.name.encode())
            digest.update(f.read_bytes())
    return digest.hexdigest()[:10]


ASSET_VERSION = _asset_version()
_ASSET_RE = re.compile(r'((?:href|src)="/static/[^"?]+\.(?:css|js))"')
_page_cache: dict[str, str] = {}


def render_page(name: str) -> HTMLResponse:
    html = _page_cache.get(name)
    if html is None:
        html = (static_path / name).read_text(encoding="utf-8")
        html = _ASSET_RE.sub(rf'\1?v={ASSET_VERSION}"', html)
        _page_cache[name] = html
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})


@app.get("/", response_class=HTMLResponse)
async def index():
    """Serve the player (mobile) interface."""
    return render_page("player.html")


@app.get("/host", response_class=HTMLResponse)
async def host():
    """Serve the host (beamer) interface."""
    return render_page("host.html")


@app.get("/creator", response_class=HTMLResponse)
async def creator():
    """Serve the quiz creator interface."""
    return render_page("creator.html")


@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    """Browser fragen das Icon oft direkt unter /favicon.ico an."""
    return FileResponse(static_path / "favicon.ico", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/health")
async def health():
    """Health check for Docker/Compose."""
    return {"status": "ok", "games": len(games)}


@app.get("/api/qrcode")
async def get_qrcode(request: Request, code: str):
    """Generate a QR code for the game join URL."""
    code = code.upper()
    if not GAME_CODE_RE.match(code):
        raise HTTPException(status_code=400, detail="Ungültiger Spiel-Code")
    # Get the base URL from the request
    base_url = f"{request.url.scheme}://{request.headers.get('host', 'localhost:8000')}"
    join_url = f"{base_url}/?code={code}"
    
    # Generate QR code
    qr = qrcode.QRCode(version=1, box_size=10, border=2)
    qr.add_data(join_url)
    qr.make(fit=True)
    
    img = qr.make_image(fill_color="#2D3436", back_color="white")
    
    # Save to bytes buffer
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    
    return StreamingResponse(buf, media_type="image/png")


@app.get("/api/quizzes")
async def get_quizzes():
    """Get available quizzes."""
    quizzes = load_quizzes()
    return [{"id": i, "title": q["title"], "questionCount": len(q["questions"])} for i, q in enumerate(quizzes)]


# Socket.IO events
@sio.event
async def connect(sid, environ):
    print(f"Client connected: {sid}")


def sync_game_to_db(game_code: str):
    """Sync in-memory game state to database."""
    if game_code not in games:
        return
    
    game = games[game_code]
    db.update_game(
        game_code,
        host_sid=game["host_sid"],
        current_question=game["current_question"],
        state=game["state"],
        team_mode=game["team_mode"],
        teams=game["teams"],
        top_n_players=game["top_n_players"]
    )


def load_game_from_db(game_code: str) -> bool:
    """Load game from database into memory."""
    game_data = db.get_game(game_code)
    if not game_data:
        return False
    
    # Load players
    players_data = db.get_players(game_code)
    players = {}
    for p in players_data:
        players[p["session_id"]] = {
            "name": p["name"],
            "score": p["score"],
            "team": p["team"],
            "streak": 0,  # Reset streak on load
            "token": p.get("token"),
        }
    
    game = new_game_state(game_data["host_sid"], game_data["quiz"], game_data.get("host_token"))
    game.update({
        "players": players,
        "current_question": game_data["current_question"],
        "state": game_data["state"],
        "team_mode": game_data["team_mode"],
        "teams": game_data["teams"],
        "top_n_players": game_data["top_n_players"],
    })

    # A question that was running when the server stopped cannot be resumed
    # (timers are gone). Park the game so the host can continue with "next".
    if game["state"] in RUNNING_STATES:
        game["state"] = "results" if game["current_question"] >= 0 else "lobby"

    games[game_code] = game
    return True


@sio.event
async def reconnect_host(sid, data):
    """Host reconnects to their game."""
    game_code = str(data.get("code") or "").upper()
    
    # Try to load from database if not in memory
    if game_code not in games:
        if not load_game_from_db(game_code):
            await sio.emit("reconnect_failed", {"message": "Spiel nicht gefunden"}, to=sid)
            return
    
    game = games[game_code]

    # Only the original host (who holds the secret token) may take over the game.
    # Without this check every player knowing the game code could hijack the host view.
    if not game.get("host_token") or not secrets.compare_digest(str(data.get("token") or ""), game["host_token"]):
        await sio.emit("reconnect_failed", {"message": "Keine Berechtigung für dieses Spiel"}, to=sid)
        return

    # Cancel any pending cleanup task
    if game_code in host_disconnect_tasks:
        print(f"Host reconnected to game {game_code}, cancelling cleanup task")
        host_disconnect_tasks[game_code].cancel()
        del host_disconnect_tasks[game_code]
    
    # Clear disconnected flag
    game["host_disconnected"] = False
    
    # Update host SID
    game["host_sid"] = sid
    db.update_game(game_code, host_sid=sid)
    await sio.enter_room(sid, game_code)
    
    # Notify players that host is back
    await sio.emit("host_reconnected", {
        "message": "Der Host ist wieder verbunden!"
    }, room=game_code)
    
    # Send current game state to host
    await sio.emit("reconnected_host", {
        "code": game_code,
        "quiz_title": game["quiz"]["title"],
        "state": game["state"],
        "current_question": game["current_question"],
        "players": player_list(game),
        "team_mode": game["team_mode"],
        "teams": game["teams"],
    }, to=sid)

    # Restore the screen content the host missed while being away
    if game["state"] == "results" and game.get("last_results"):
        await sio.emit("show_results", game["last_results"], to=sid)
    elif game["state"] == "ended" and game.get("final_results"):
        await sio.emit("game_ended", game["final_results"], to=sid)


def transfer_player(game: dict, old_sid: str, new_sid: str):
    """Move a player's in-memory state (score, answer, history) to a new socket id."""
    player_data = game["players"].pop(old_sid)
    player_data["disconnected"] = False
    game["players"][new_sid] = player_data
    if old_sid in game["answers"]:
        game["answers"][new_sid] = game["answers"].pop(old_sid)
    if old_sid in game["answer_history"]:
        game["answer_history"][new_sid] = game["answer_history"].pop(old_sid)


@sio.event
async def reconnect_player(sid, data):
    """Player reconnects to their game."""
    game_code = str(data.get("code") or "").upper()
    player_name = str(data.get("name") or "").strip()

    # Try to load from database if not in memory
    if game_code not in games:
        if not load_game_from_db(game_code):
            await sio.emit("reconnect_failed", {"message": "Spiel nicht gefunden"}, to=sid)
            return

    game = games[game_code]

    # Find player by name
    old_sid = None
    for player_sid, player in game["players"].items():
        if player["name"].lower() == player_name.lower():
            old_sid = player_sid
            break

    if old_sid is None:
        # In the lobby, players are removed on disconnect (e.g. page reload).
        # Simply let them join again instead of kicking them to the join screen.
        if game["state"] == "lobby" and player_name:
            await join_game(sid, {"code": game_code, "name": player_name})
            return
        await sio.emit("reconnect_failed", {"message": "Spieler nicht gefunden"}, to=sid)
        return

    if old_sid == sid:
        return

    # Nur wer den geheimen Spieler-Token hat, darf eine bestehende Verbindung übernehmen.
    # Code und Name stehen auf dem Beamer – ohne Token könnte jeder andere Spieler übernehmen.
    # Ohne passenden Token gilt dieselbe Regel wie beim Beitritt mit gleichem Namen
    # (nur erlaubt, wenn der Spieler tatsächlich getrennt ist).
    stored_token = game["players"][old_sid].get("token") or ""
    if not stored_token or not secrets.compare_digest(str(data.get("token") or ""), stored_token):
        await join_game(sid, {"code": game_code, "name": player_name})
        return

    transfer_player(game, old_sid, sid)
    player_data = game["players"][sid]
    db.update_player_session(game_code, player_data["name"], sid)

    await sio.enter_room(sid, game_code)
    await sio.emit("player_reconnected", {
        "name": player_data["name"],
        "message": f"{player_data['name']} ist wieder verbunden"
    }, room=game_code)

    # Send current game state
    await sio.emit("reconnected_player", {
        "code": game_code,
        "name": player_data["name"],
        "player_token": player_data["token"],
        "quiz_title": game["quiz"]["title"],
        "state": game["state"],
        "score": player_data["score"],
        "team": player_data["team"],
        "team_mode": game["team_mode"],
        "teams": game["teams"],
    }, to=sid)

    # Laufende Frage nachliefern: Fragen werden nur einmal beim Start der Frage verschickt.
    # Ohne das sah ein Spieler nach dem Reconnect einen leeren Fragebildschirm und verpasste die Frage.
    await send_current_question(game, sid)


async def send_current_question(game: dict, sid: str):
    """Schickt einem (wieder) verbundenen Spieler die gerade laufende Frage mit Restzeit."""
    if game["state"] not in ("reading", "question"):
        return
    index = game["current_question"]
    questions = game["quiz"]["questions"]
    if not 0 <= index < len(questions):
        return
    question = questions[index]
    now = asyncio.get_event_loop().time()
    reading_time = game.get("reading_time") or 0
    reading_left = reading_time - (now - (game.get("reading_start_time") or now))

    await sio.emit("show_question_reading", {
        "question_num": index + 1,
        "total_questions": len(questions),
        "question": question["question"],
        "reading_time": max(reading_left, 0.1) if game["state"] == "reading" else 0.1,
    }, to=sid)

    if game["state"] != "question":
        return  # show_answers kommt regulär nach der Lesezeit an alle Spieler

    if sid in game["answers"]:
        await sio.emit("answer_received", {}, to=sid)
        return

    time_limit = question.get("time_limit", 20)
    elapsed = now - (game.get("question_start_time") or now)
    await sio.emit("show_answers", {
        "answers": question["answers"],
        "time_limit": time_limit,
        "time_left": max(time_limit - elapsed, 0),
    }, to=sid)


@sio.event
async def disconnect(sid):
    print(f"Client disconnected: {sid}")
    # Mark player as disconnected in database
    db.set_player_connected(sid, False)
    
    # Find which game this player was in and notify the host
    for game_code, game in list(games.items()):
        if sid in game["players"]:
            player_name = game["players"][sid]["name"]
            
            # Only remove player if game is in lobby state
            # During active game, keep player data for reconnection
            if game["state"] == "lobby":
                # Remove player from game in lobby
                del game["players"][sid]
                
                # Notify host and remaining players about the disconnection
                players_payload = player_list(game)
                await sio.emit("player_left", {
                    "name": player_name,
                    "players": players_payload
                }, room=game_code)
            else:
                # Game is active - mark player as disconnected but keep their data
                game["players"][sid]["disconnected"] = True
                print(f"Player {player_name} disconnected during active game {game_code}, keeping data for reconnection")
                
                # Notify host about temporary disconnection
                await sio.emit("player_disconnected", {
                    "name": player_name,
                    "message": f"{player_name} hat die Verbindung verloren"
                }, room=game_code)
            break
        elif sid == game["host_sid"]:
            # Host disconnected - start grace period for reconnection
            print(f"Host disconnected from game {game_code}, starting {HOST_RECONNECT_GRACE_PERIOD}s grace period")
            
            # Mark host as disconnected (but don't delete game)
            game["host_disconnected"] = True
            
            # Notify players that host is temporarily disconnected
            await sio.emit("host_disconnected", {
                "message": "Der Host hat die Verbindung verloren. Warte auf Wiederverbindung...",
                "grace_period": HOST_RECONNECT_GRACE_PERIOD
            }, room=game_code)
            
            # Cancel any existing cleanup task for this game
            if game_code in host_disconnect_tasks:
                host_disconnect_tasks[game_code].cancel()
            
            # Start cleanup task with grace period
            async def cleanup_after_grace_period(code: str):
                try:
                    await asyncio.sleep(HOST_RECONNECT_GRACE_PERIOD)
                    # Check if host is still disconnected
                    if code in games and games[code].get("host_disconnected", False):
                        print(f"Host did not reconnect to game {code}, ending game")
                        await sio.emit("game_ended", {
                            "reason": "Der Host hat das Spiel verlassen."
                        }, room=code)
                        await asyncio.sleep(0.5)
                        games.pop(code, None)
                        # Also remove from DB, otherwise a later reconnect would revive the game
                        db.delete_game(code)
                    # Clean up task reference
                    if code in host_disconnect_tasks:
                        del host_disconnect_tasks[code]
                except asyncio.CancelledError:
                    # Task was cancelled because host reconnected
                    pass
            
            host_disconnect_tasks[game_code] = asyncio.create_task(
                cleanup_after_grace_period(game_code)
            )
            break


@sio.event
async def create_game(sid, data):
    """Host creates a new game."""
    quiz = get_builtin_quiz(data.get("quiz_id", 0))
    if quiz is None:
        await sio.emit("error", {"message": "Quiz nicht gefunden"}, to=sid)
        return
    await _create_game_with_quiz(sid, quiz)


async def _create_game_with_quiz(sid: str, quiz: dict):
    if len(games) >= MAX_ACTIVE_GAMES:
        await sio.emit("error", {"message": "Gerade laufen zu viele Spiele – bitte später nochmal versuchen"}, to=sid)
        return
    game_code = generate_game_code()
    host_token = secrets.token_hex(16)

    db.create_game(game_code, sid, quiz["title"], quiz, host_token=host_token)
    games[game_code] = new_game_state(sid, quiz, host_token)

    await sio.enter_room(sid, game_code)
    await sio.emit("game_created", {
        "code": game_code,
        "host_token": host_token,
        "quiz_title": quiz["title"],
        "question_count": len(quiz["questions"])
    }, to=sid)


@sio.event
async def create_custom_game(sid, data):
    """Host creates a new game with a custom quiz."""
    quiz = data.get("quiz")
    error = validate_quiz(quiz)
    if error:
        await sio.emit("error", {"message": error}, to=sid)
        return
    await _create_game_with_quiz(sid, {"title": quiz["title"], "questions": quiz["questions"]})


def apply_quiz_switch(game_code: str, quiz: dict) -> list[dict]:
    """Apply quiz switch while keeping the same game session and players."""
    game = games[game_code]

    game["quiz"] = quiz
    game["current_question"] = -1
    game["state"] = "lobby"
    game["answers"] = {}
    game["question_start_time"] = None
    game["answer_history"] = {}
    game["last_results"] = None
    game["final_results"] = None

    for player in game["players"].values():
        player["score"] = 0
        player["streak"] = 0
        if not game["team_mode"]:
            player["team"] = None

    db.update_game(
        game_code,
        quiz_name=quiz["title"],
        quiz=quiz,
        current_question=-1,
        state="lobby",
    )
    db.reset_game_progress(game_code, reset_teams=not game["team_mode"])

    return player_list(game)


async def _switch_quiz(sid: str, game_code, quiz: dict):
    if game_code not in games:
        await sio.emit("error", {"message": "Spiel nicht gefunden"}, to=sid)
        return

    game = games[game_code]
    if game["host_sid"] != sid:
        return

    if game["state"] not in ("lobby", "ended"):
        await sio.emit("error", {"message": "Quizwechsel ist nur in der Lobby oder nach Spielende möglich"}, to=sid)
        return

    players = apply_quiz_switch(game_code, quiz)
    await sio.emit("game_quiz_switched", {
        "code": game_code,
        "quiz_title": quiz["title"],
        "question_count": len(quiz["questions"]),
        "players": players,
    }, to=sid)

    for player_sid, player in game["players"].items():
        await sio.emit("quiz_switched", {
            "code": game_code,
            "quiz_title": quiz["title"],
            "team_mode": game["team_mode"],
            "teams": game["teams"],
            "team": player["team"],
        }, to=player_sid)


@sio.event
async def switch_game_quiz(sid, data):
    """Host switches the quiz within an existing game session."""
    quiz = get_builtin_quiz(data.get("quiz_id", 0))
    if quiz is None:
        await sio.emit("error", {"message": "Quiz nicht gefunden"}, to=sid)
        return
    await _switch_quiz(sid, data.get("code"), quiz)


@sio.event
async def switch_custom_game_quiz(sid, data):
    """Host switches to a custom quiz within an existing game session."""
    quiz = data.get("quiz")
    error = validate_quiz(quiz)
    if error:
        await sio.emit("error", {"message": error}, to=sid)
        return
    await _switch_quiz(sid, data.get("code"), {"title": quiz["title"], "questions": quiz["questions"]})


@sio.event
async def join_game(sid, data):
    """Player joins a game."""
    game_code = str(data.get("code") or "").strip().upper()
    player_name = str(data.get("name") or "").strip()[:MAX_NAME_LENGTH]

    if not player_name:
        await sio.emit("error", {"message": "Bitte gib einen Namen ein"}, to=sid)
        return

    if game_code not in games:
        await sio.emit("error", {"message": "Spiel nicht gefunden"}, to=sid)
        return

    game = games[game_code]

    # Check if player with same name already exists (potential reconnect)
    existing_sid = None
    for player_sid, player in game["players"].items():
        if player["name"].lower() == player_name.lower():
            existing_sid = player_sid
            break

    if existing_sid == sid:
        return  # Same socket joined twice (double click) - nothing to do

    if existing_sid is not None:
        # Only take over the slot of a player who actually lost the connection.
        # Otherwise a second person with the same name would silently steal
        # the score/session of the first one.
        if not game["players"][existing_sid].get("disconnected"):
            await sio.emit("error", {"message": "Dieser Name ist bereits vergeben"}, to=sid)
            return

        transfer_player(game, existing_sid, sid)
        player_data = game["players"][sid]
        player_data["token"] = secrets.token_urlsafe(16)  # alter Token verliert seine Gültigkeit
        db.update_player_session(game_code, player_data["name"], sid)
        db.set_player_token(game_code, player_data["name"], player_data["token"])

        await sio.enter_room(sid, game_code)
        
        # Notify host that player reconnected
        await sio.emit("player_reconnected", {
            "name": player_name,
            "message": f"{player_name} ist wieder verbunden"
        }, room=game_code)
        
        # Send current game state (same as reconnect_player)
        await sio.emit("reconnected_player", {
            "code": game_code,
            "name": player_data["name"],
            "player_token": player_data["token"],
            "quiz_title": game["quiz"]["title"],
            "state": game["state"],
            "score": player_data["score"],
            "team": player_data["team"],
            "team_mode": game["team_mode"],
            "teams": game["teams"],
        }, to=sid)
        
        print(f"Player {player_name} reconnected to game {game_code}")
        await send_current_question(game, sid)
        return
    
    # New player - only allow in lobby state
    if game["state"] != "lobby":
        await sio.emit("error", {"message": "Spiel hat bereits begonnen"}, to=sid)
        return
    
    if len(game["players"]) >= MAX_PLAYERS_PER_GAME:
        await sio.emit("error", {"message": "Das Spiel ist voll"}, to=sid)
        return

    player_token = secrets.token_urlsafe(16)

    # Add to database
    if not db.add_player(game_code, sid, player_name, token=player_token):
        await sio.emit("error", {"message": "Fehler beim Beitreten"}, to=sid)
        return
    
    game["players"][sid] = {
        "name": player_name,
        "score": 0,
        "streak": 0,
        "team": None,
        "token": player_token,
    }
    
    await sio.enter_room(sid, game_code)
    await sio.emit("joined_game", {
        "code": game_code,
        "name": player_name,
        "player_token": player_token,
        "quiz_title": game["quiz"]["title"],
        "team_mode": game["team_mode"],
        "teams": game["teams"]
    }, to=sid)
    
    # Notify host
    players_payload = player_list(game)
    await sio.emit("player_joined", {
        "name": player_name,
        "players": players_payload
    }, room=game_code)


@sio.event
async def start_game(sid, data):
    """Host starts the game."""
    game_code = data.get("code")
    
    if game_code not in games:
        return
    
    game = games[game_code]
    
    if game["host_sid"] != sid:
        return
    
    if game["state"] != "lobby":
        return  # already started (e.g. double click)

    if len(game["players"]) < 1:
        await sio.emit("error", {"message": "Mindestens 1 Spieler benötigt"}, to=sid)
        return
    
    game["state"] = "starting"
    await sio.emit("game_starting", {}, room=game_code)
    
    # Short countdown before first question
    sync_game_to_db(game_code)
    await asyncio.sleep(3)
    await next_question(game_code)


async def next_question(game_code: str):
    """Send the next question to all players."""
    if game_code not in games:
        return
    
    game = games[game_code]
    game["current_question"] += 1
    game["answers"] = {}
    
    if game["current_question"] >= len(game["quiz"]["questions"]):
        # Game over
        await end_game(game_code)
        return
    
    question_index = game["current_question"]
    question = game["quiz"]["questions"][question_index]
    game["state"] = "reading"  # New state for reading phase
    
    # Calculate reading time based on question length
    reading_time = calculate_reading_time(question["question"])
    game["reading_time"] = reading_time
    game["reading_start_time"] = asyncio.get_event_loop().time()
    
    # Sync to database
    sync_game_to_db(game_code)
    
    # Send reading phase to host (question only, no timer yet)
    await sio.emit("show_question_reading", {
        "question_num": game["current_question"] + 1,
        "total_questions": len(game["quiz"]["questions"]),
        "question": question["question"],
        "reading_time": reading_time,
    }, to=game["host_sid"])
    
    # Send reading phase to players (question only)
    for player_sid in game["players"]:
        await sio.emit("show_question_reading", {
            "question_num": game["current_question"] + 1,
            "total_questions": len(game["quiz"]["questions"]),
            "question": question["question"],
            "reading_time": reading_time,
        }, to=player_sid)
    
    # Wait for reading time, then show answers
    await asyncio.sleep(reading_time)
    
    # Check if game still exists and is still reading the same question
    if (games.get(game_code) is not game or game["state"] != "reading"
            or game["current_question"] != question_index):
        return
    
    game["state"] = "question"
    game["question_start_time"] = asyncio.get_event_loop().time()
    
    # Send answers to host (with correct answer)
    await sio.emit("show_answers", {
        "answers": question["answers"],
        "correct_index": question["correct"],
        "time_limit": question.get("time_limit", 20),
    }, to=game["host_sid"])
    
    # Send answers to players (without correct answer)
    for player_sid in game["players"]:
        await sio.emit("show_answers", {
            "answers": question["answers"],
            "time_limit": question.get("time_limit", 20),
        }, to=player_sid)

    # Server-side safety timer: previously only the host browser sent "time_up".
    # If the host reloaded/lost connection during a question the game hung forever.
    asyncio.create_task(question_timeout(game_code, question_index, question.get("time_limit", 20)))


async def question_timeout(game_code: str, question_index: int, time_limit: float):
    await asyncio.sleep(time_limit + 1.5)  # small grace so the host timer normally wins
    game = games.get(game_code)
    if game and game["state"] == "question" and game["current_question"] == question_index:
        await show_results(game_code)


@sio.event
async def submit_answer(sid, data):
    """Player submits an answer."""
    game_code = data.get("code")
    answer_index = data.get("answer")
    
    if game_code not in games:
        return
    
    game = games[game_code]
    
    if sid not in game["players"]:
        return
    
    if game["state"] != "question":
        return
    
    if sid in game["answers"]:
        return  # Already answered

    if not _is_int(answer_index) or not 0 <= answer_index <= 3:
        return  # invalid payload would crash show_results
    
    # Calculate response time
    response_time = asyncio.get_event_loop().time() - game["question_start_time"]
    question = game["quiz"]["questions"][game["current_question"]]
    time_limit = question.get("time_limit", 20)
    
    game["answers"][sid] = {
        "answer": answer_index,
        "time": response_time,
    }
    
    # Track answer history for inactive detection
    if sid not in game["answer_history"]:
        game["answer_history"][sid] = []
    game["answer_history"][sid].append(game["current_question"])
    
    # Record answer in database
    player = game["players"][sid]
    is_correct = answer_index == question["correct"]
    db.record_answer(
        game_code,
        player["name"],
        game["current_question"],
        answer_index,
        is_correct,
        int(response_time * 1000),  # Convert to milliseconds
        0  # Points will be updated in show_results
    )
    
    await sio.emit("answer_received", {}, to=sid)
    
    # Notify host of answer count
    await sio.emit("answer_update", {
        "answered": len(game["answers"]),
        "total": len(game["players"])
    }, to=game["host_sid"])
    
    # If all players answered, show results
    if len(game["answers"]) >= len(game["players"]):
        await show_results(game_code)


@sio.event
async def autoplay_started(sid, data):
    """Host signals autoplay countdown has started - forward to players."""
    game_code = data.get("code")
    seconds = data.get("seconds", 10)  # Default matches AUTOPLAY_COUNTDOWN_SECONDS in JS
    is_last_question = data.get("is_last_question", False)
    
    if game_code not in games:
        return
    
    game = games[game_code]
    
    if game["host_sid"] != sid:
        return
    
    # Send autoplay countdown to all players
    for player_sid in game["players"]:
        await sio.emit("autoplay_countdown", {"seconds": seconds, "is_last_question": is_last_question}, to=player_sid)


@sio.event
async def time_up(sid, data):
    """Host signals time is up."""
    game_code = data.get("code")
    
    if game_code not in games:
        return
    
    game = games[game_code]
    
    if game["host_sid"] != sid:
        return
    
    await show_results(game_code)


async def check_and_remove_inactive_players(game_code: str):
    """Check for inactive players and remove them if auto-remove is enabled."""
    if game_code not in games:
        return
    
    game = games[game_code]
    
    # Only check if auto-remove is enabled
    if not game.get("auto_remove_inactive", False):
        return
    
    threshold = game.get("inactivity_threshold", DEFAULT_INACTIVITY_THRESHOLD)
    current_question = game["current_question"]
    
    # Need at least threshold questions to detect inactivity
    if current_question < threshold - 1:
        return
    
    inactive_players = []
    
    for player_sid, player_data in list(game["players"].items()):
        # Check answer history for this player
        answer_history = game.get("answer_history", {}).get(player_sid, [])
        
        # Check if player has answered any of the last N questions
        recent_questions = list(range(max(0, current_question - threshold + 1), current_question + 1))
        has_recent_answer = any(q in answer_history for q in recent_questions)
        
        if not has_recent_answer:
            inactive_players.append({
                "sid": player_sid,
                "name": player_data["name"]
            })
    
    # Remove inactive players
    if inactive_players:
        for player_info in inactive_players:
            player_sid = player_info["sid"]
            player_name = player_info["name"]
            
            # Remove from game
            if player_sid in game["players"]:
                del game["players"][player_sid]
            
            # Remove from answer history
            if player_sid in game.get("answer_history", {}):
                del game["answer_history"][player_sid]
            
            # Remove from current answers if present
            if player_sid in game.get("answers", {}):
                del game["answers"][player_sid]

            # Tell the player and take them out of the room, otherwise their
            # phone stays on an outdated screen and still receives broadcasts
            await sio.emit("game_ended", {"reason": "Du wurdest wegen Inaktivität entfernt."}, to=player_sid)
            await sio.leave_room(player_sid, game_code)
            
            print(f"Removed inactive player {player_name} from game {game_code}")
        
        # Notify host about removed players
        await sio.emit("inactive_players_removed", {
            "players": [p["name"] for p in inactive_players],
            "count": len(inactive_players)
        }, to=game["host_sid"])


async def show_results(game_code: str):
    """Calculate and show results for the current question."""
    if game_code not in games:
        return
    
    game = games[game_code]
    
    if game["state"] != "question":
        return
    
    game["state"] = "results"
    question = game["quiz"]["questions"][game["current_question"]]
    correct_index = question["correct"]
    time_limit = question.get("time_limit", 20)
    
    results = []
    answer_counts = [0, 0, 0, 0]
    
    for player_sid, answer_data in game["answers"].items():
        player = game["players"][player_sid]
        is_correct = answer_data["answer"] == correct_index
        
        if answer_data["answer"] is not None and answer_data["answer"] < 4:
            answer_counts[answer_data["answer"]] += 1
        
        if is_correct:
            # Score based on speed (max 1000, min 500)
            time_bonus = max(0, 1 - (answer_data["time"] / time_limit))
            score = int(500 + (500 * time_bonus))
            player["streak"] += 1
            # Streak bonus
            if player["streak"] > 1:
                score += min(player["streak"] * 50, 200)
            player["score"] += score
            
            # Update database
            db.update_player_score(game_code, player["name"], player["score"])
            
            results.append({
                "sid": player_sid,
                "name": player["name"],
                "correct": True,
                "score_gained": score,
                "total_score": player["score"],
                "streak": player["streak"],
            })
        else:
            player["streak"] = 0
            results.append({
                "sid": player_sid,
                "name": player["name"],
                "correct": False,
                "score_gained": 0,
                "total_score": player["score"],
                "streak": 0,
            })
    
    # Players who didn't answer
    for player_sid in game["players"]:
        if player_sid not in game["answers"]:
            player = game["players"][player_sid]
            player["streak"] = 0
            results.append({
                "sid": player_sid,
                "name": player["name"],
                "correct": False,
                "score_gained": 0,
                "total_score": player["score"],
                "streak": 0,
            })
    
    # Sort by score
    results.sort(key=lambda x: x["total_score"], reverse=True)
    
    # Check if this is the last question
    is_last_question = game["current_question"] >= len(game["quiz"]["questions"]) - 1
    
    # Send results to host
    game["last_results"] = {
        "correct_index": correct_index,
        "correct_answer": question["answers"][correct_index],
        "answer_counts": answer_counts,
        "results": [{"name": r["name"], "correct": r["correct"], "score_gained": r["score_gained"], "total_score": r["total_score"]} for r in results],
        "is_last_question": is_last_question,
    }
    await sio.emit("show_results", game["last_results"], to=game["host_sid"])
    
    # Send individual results to players
    for result in results:
        await sio.emit("your_result", {
            "correct": result["correct"],
            "correct_answer": question["answers"][correct_index],
            "score_gained": result["score_gained"],
            "total_score": result["total_score"],
            "streak": result["streak"],
            "rank": results.index(result) + 1,
            "total_players": len(results),
            "is_last_question": is_last_question,
        }, to=result["sid"])
    
    # Check and remove inactive players if enabled
    await check_and_remove_inactive_players(game_code)


@sio.event
async def configure_teams(sid, data):
    """Host configures team mode."""
    game_code = data.get("code")
    team_mode = data.get("team_mode", False)
    teams = data.get("teams", [])
    top_n_players = data.get("top_n_players", 3)
    
    if game_code not in games:
        return
    
    game = games[game_code]
    
    if game["host_sid"] != sid:
        return
    
    if game["state"] != "lobby":
        return
    
    if not isinstance(teams, list):
        teams = []
    teams = list(dict.fromkeys(str(t).strip()[:30] for t in teams if str(t).strip()))[:MAX_TEAMS]
    team_mode = bool(team_mode) and len(teams) > 0
    if not _is_int(top_n_players) or top_n_players < 1:
        top_n_players = 3

    game["team_mode"] = team_mode
    game["teams"] = teams
    game["top_n_players"] = top_n_players
    
    # Update database
    db.update_game(game_code, team_mode=team_mode, teams=teams, top_n_players=top_n_players)
    
    # Notify all players about team mode update
    await sio.emit("team_config_updated", {
        "team_mode": team_mode,
        "teams": teams
    }, room=game_code)


@sio.event
async def configure_auto_remove(sid, data):
    """Host configures auto-remove inactive users settings."""
    game_code = data.get("code")
    auto_remove_inactive = data.get("auto_remove_inactive", False)
    inactivity_threshold = data.get("inactivity_threshold", DEFAULT_INACTIVITY_THRESHOLD)
    
    if game_code not in games:
        return
    
    game = games[game_code]
    
    if game["host_sid"] != sid:
        return
    
    if game["state"] != "lobby":
        return
    
    # Validate threshold
    if not _is_int(inactivity_threshold):
        inactivity_threshold = DEFAULT_INACTIVITY_THRESHOLD
    if inactivity_threshold < 1:
        inactivity_threshold = 1
    elif inactivity_threshold > 10:
        inactivity_threshold = 10
    
    game["auto_remove_inactive"] = auto_remove_inactive
    game["inactivity_threshold"] = inactivity_threshold
    
    print(f"Auto-remove inactive configured for game {game_code}: enabled={auto_remove_inactive}, threshold={inactivity_threshold}")



@sio.event
async def select_team(sid, data):
    """Player selects their team."""
    game_code = data.get("code")
    team = data.get("team")
    
    if game_code not in games:
        return
    
    game = games[game_code]
    
    if sid not in game["players"]:
        return
    
    if game["state"] != "lobby":
        return
    
    if not game["team_mode"]:
        return
    
    if team not in game["teams"]:
        await sio.emit("error", {"message": "Ungültiges Team"}, to=sid)
        return
    
    game["players"][sid]["team"] = team
    
    # Update database
    db.update_player_team(game_code, game["players"][sid]["name"], team)
    
    # Notify host and all players
    players_payload = player_list(game)
    await sio.emit("player_updated", {
        "players": players_payload
    }, room=game_code)


@sio.event
async def next_question_request(sid, data):
    """Host requests next question."""
    game_code = data.get("code")
    
    if game_code not in games:
        return
    
    game = games[game_code]
    
    if game["host_sid"] != sid:
        return

    # Only advance from the results screen. Otherwise a double click / autoplay
    # race skips questions or mixes up answers of two questions.
    if game["state"] != "results":
        return
    
    await next_question(game_code)


@sio.event
async def end_game_request(sid, data):
    """Host requests to end the game early."""
    game_code = data.get("code")
    
    if game_code not in games:
        return
    
    game = games[game_code]
    
    if game["host_sid"] != sid:
        return
    
    # Clean up first (memory + DB), so nobody can reconnect into the dying game
    games.pop(game_code, None)
    db.delete_game(game_code)
    task = host_disconnect_tasks.pop(game_code, None)
    if task:
        task.cancel()

    # Notify all players that the game has ended (socket rooms are independent of `games`)
    await sio.emit("game_ended", {"message": "Das Spiel wurde vom Host beendet."}, room=game_code)


async def end_game(game_code: str):
    """End the game and show final leaderboard."""
    if game_code not in games:
        return
    
    game = games[game_code]
    game["state"] = "ended"
    
    # Final leaderboard
    leaderboard = [
        {"name": p["name"], "score": p["score"], "team": p["team"]}
        for p in game["players"].values()
    ]
    leaderboard.sort(key=lambda x: x["score"], reverse=True)
    
    # Calculate team leaderboard if team mode is enabled
    team_leaderboard = []
    if game["team_mode"]:
        team_scores = {}
        for team in game["teams"]:
            # Get all players in this team
            team_players = [
                {"name": p["name"], "score": p["score"]}
                for p in game["players"].values()
                if p["team"] == team
            ]
            # Sort by score and take top N players
            team_players.sort(key=lambda x: x["score"], reverse=True)
            top_players = team_players[:game["top_n_players"]]
            # Sum scores of top players
            team_total = sum(p["score"] for p in top_players)
            team_scores[team] = {
                "team": team,
                "score": team_total,
                "player_count": len(team_players),
                "top_players": top_players
            }
        
        team_leaderboard = list(team_scores.values())
        team_leaderboard.sort(key=lambda x: x["score"], reverse=True)
    
    game["final_results"] = {
        "leaderboard": leaderboard,
        "team_mode": game["team_mode"],
        "team_leaderboard": team_leaderboard,
        "top_n_players": game["top_n_players"]
    }
    await sio.emit("game_ended", game["final_results"], room=game_code)
    
    # Update final state in database
    db.update_game(game_code, state="ended")


if __name__ == "__main__":
    import uvicorn
    import os
    uvicorn.run(socket_app, host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
