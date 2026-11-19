"""
SmartQuiz – Abstimmung (z. B. „Bestes Lebkuchenhaus“).

Ablauf wie beim Quiz: Host legt Titel + Optionen fest, zeigt QR-Code, Leute melden sich mit
Namen an, Host öffnet die Abstimmung, jede Person hat eine Stimme (bis zum Ende änderbar),
Host beendet die Abstimmung und bekommt die Siegerehrung.

Spiel-Codes teilen sich den Namensraum mit den Quiz-Spielen, Spieler nutzen dieselbe
Beitrittsseite. main.py leitet join_game/reconnect_player für Abstimmungs-Codes hierher.
"""

from __future__ import annotations

import secrets
import time

import database as db

MAX_POLLS = 100
MAX_POLL_OPTIONS = 40
MAX_POLL_TITLE = 100
MAX_OPTION_NAME = 60
MAX_OPTION_DETAIL = 80
MAX_VOTERS = 300
MAX_NAME_LENGTH = 20

# code -> Zustand. Wähler sind nach ihrem geheimen Token sortiert (überlebt Socket-Wechsel).
# {
#   "host_token", "host_sid", "title", "options": [{"name", "detail"}],
#   "state": "lobby" | "open" | "closed",
#   "voters": {token: {"name", "sid", "vote": int | None, "connected": bool}},
#   "created": float,
# }
polls: dict[str, dict] = {}

sio = None  # wird von register() gesetzt


def _clean(text, limit: int) -> str:
    return " ".join(str(text or "").split())[:limit]


def validate_options(data) -> tuple[str, list[dict]] | str:
    """Gibt (titel, optionen) zurück oder eine Fehlermeldung."""
    if not isinstance(data, dict):
        return "Ungültige Abstimmung"
    title = _clean(data.get("title"), MAX_POLL_TITLE)
    if not title:
        return "Bitte gib der Abstimmung einen Titel"
    raw = data.get("options")
    if not isinstance(raw, list):
        return "Ungültige Optionen"
    options = []
    seen = set()
    for item in raw[:MAX_POLL_OPTIONS + 1]:
        if not isinstance(item, dict):
            return "Ungültige Optionen"
        name = _clean(item.get("name"), MAX_OPTION_NAME)
        if not name:
            continue
        if name.lower() in seen:
            return f"„{name}“ steht doppelt in der Liste"
        seen.add(name.lower())
        options.append({"name": name, "detail": _clean(item.get("detail"), MAX_OPTION_DETAIL)})
    if len(options) < 2:
        return "Es braucht mindestens zwei Optionen"
    if len(options) > MAX_POLL_OPTIONS:
        return f"Höchstens {MAX_POLL_OPTIONS} Optionen"
    return title, options


def results(poll: dict) -> dict:
    """Stimmen je Option, absteigend sortiert; bei Gleichstand gewinnen alle mit den meisten Stimmen."""
    counts = [0] * len(poll["options"])
    for voter in poll["voters"].values():
        if voter["vote"] is not None and 0 <= voter["vote"] < len(counts):
            counts[voter["vote"]] += 1
    total = sum(counts)
    ranking = sorted(
        ({"index": i, "name": o["name"], "detail": o["detail"], "votes": counts[i]}
         for i, o in enumerate(poll["options"])),
        key=lambda r: (-r["votes"], r["index"]),
    )
    best = ranking[0]["votes"] if ranking else 0
    winners = [r["index"] for r in ranking if best > 0 and r["votes"] == best]
    # Platz mit Gleichstand: 1, 1, 3 …
    place = 0
    for pos, row in enumerate(ranking):
        if pos == 0 or row["votes"] != ranking[pos - 1]["votes"]:
            place = pos + 1
        row["place"] = place
    return {"ranking": ranking, "winners": winners, "total_votes": total}


def host_view(code: str, poll: dict) -> dict:
    voters = sorted(poll["voters"].values(), key=lambda v: v["name"].lower())
    view = {
        "code": code,
        "title": poll["title"],
        "options": poll["options"],
        "state": poll["state"],
        "voters": [{"name": v["name"], "voted": v["vote"] is not None, "connected": v["connected"]}
                   for v in voters],
        "votes_cast": sum(1 for v in voters if v["vote"] is not None),
    }
    if poll["state"] == "closed":
        view["results"] = results(poll)
    return view


def voter_view(code: str, poll: dict, voter: dict, token: str) -> dict:
    view = {
        "code": code,
        "name": voter["name"],
        "player_token": token,
        "title": poll["title"],
        "options": poll["options"],
        "state": poll["state"],
        "my_vote": voter["vote"],
    }
    if poll["state"] == "closed":
        view["results"] = results(poll)
    return view


def _save(code: str):
    if code in polls:
        db.save_poll(code, polls[code])


async def _update_host(code: str):
    poll = polls.get(code)
    if poll and poll["host_sid"]:
        await sio.emit("poll_host_update", host_view(code, poll), to=poll["host_sid"])


def _is_host(poll: dict | None, sid: str) -> bool:
    return bool(poll) and poll["host_sid"] == sid


def _find_voter_by_name(poll: dict, name: str):
    for token, voter in poll["voters"].items():
        if voter["name"].lower() == name.lower():
            return token, voter
    return None, None


def _find_voter_by_sid(poll: dict, sid: str):
    for token, voter in poll["voters"].items():
        if voter["sid"] == sid:
            return token, voter
    return None, None


async def _attach(sid: str, code: str, token: str, voter: dict, event: str):
    voter["sid"] = sid
    voter["connected"] = True
    await sio.enter_room(sid, f"poll:{code}")
    await sio.emit(event, voter_view(code, polls[code], voter, token), to=sid)
    _save(code)
    await _update_host(code)


async def join(sid: str, code: str, name: str):
    """Neue Person meldet sich an (oder übernimmt ihren getrennten Platz)."""
    poll = polls[code]
    name = _clean(name, MAX_NAME_LENGTH)
    if not name:
        await sio.emit("error", {"message": "Bitte gib einen Namen ein"}, to=sid)
        return
    token, voter = _find_voter_by_name(poll, name)
    if voter is not None:
        if voter["sid"] == sid:
            return  # Doppelklick
        if voter["connected"]:
            await sio.emit("error", {"message": "Dieser Name ist bereits vergeben"}, to=sid)
            return
        # Platz einer getrennten Person übernehmen – neuer Token, der alte verliert seine Gültigkeit
        poll["voters"].pop(token)
        token = secrets.token_urlsafe(16)
        poll["voters"][token] = voter
        await _attach(sid, code, token, voter, "poll_joined")
        return
    if poll["state"] == "closed":
        await sio.emit("error", {"message": "Die Abstimmung ist schon beendet"}, to=sid)
        return
    if len(poll["voters"]) >= MAX_VOTERS:
        await sio.emit("error", {"message": "Die Abstimmung ist voll"}, to=sid)
        return
    token = secrets.token_urlsafe(16)
    voter = {"name": name, "sid": sid, "vote": None, "connected": True}
    poll["voters"][token] = voter
    await _attach(sid, code, token, voter, "poll_joined")


async def rejoin(sid: str, code: str, name: str, token: str):
    """Gespeicherte Sitzung auf dem Handy (Neuladen, Standby, Netzwechsel)."""
    poll = polls[code]
    voter = poll["voters"].get(str(token or ""))
    if voter is None or voter["name"].lower() != str(name or "").strip().lower():
        await join(sid, code, name)
        return
    await _attach(sid, code, str(token), voter, "poll_joined")


async def on_disconnect(sid: str) -> bool:
    """True, wenn die Verbindung zu einer Abstimmung gehörte."""
    for code, poll in polls.items():
        if poll["host_sid"] == sid:
            poll["host_sid"] = None  # Abstimmung läuft weiter, Host kann sich wieder verbinden
            return True
        _, voter = _find_voter_by_sid(poll, sid)
        if voter is not None:
            voter["connected"] = False
            voter["sid"] = None
            await _update_host(code)
            return True
    return False


def drop_old_polls():
    cutoff = time.time() - 48 * 3600
    for code in [c for c, p in polls.items() if p.get("created", 0) < cutoff]:
        polls.pop(code, None)
        db.delete_poll(code)


def register(server, new_code, admin_only):
    """Socket-Events anmelden. new_code() liefert einen freien Spiel-Code,
    admin_only schützt die Host-Befehle (Login, siehe auth.py)."""
    global sio
    sio = server

    # Gespeicherte Abstimmungen laden – nach einem Neustart sind alle alten Verbindungen weg
    polls.update(db.load_polls())
    for p in polls.values():
        p["host_sid"] = None
        for voter in p["voters"].values():
            voter["sid"] = None
            voter["connected"] = False

    @sio.event
    @admin_only
    async def create_poll(sid, data):
        checked = validate_options(data)
        if isinstance(checked, str):
            await sio.emit("poll_error", {"message": checked}, to=sid)
            return
        drop_old_polls()
        if len(polls) >= MAX_POLLS:
            await sio.emit("poll_error", {"message": "Zu viele Abstimmungen gleichzeitig"}, to=sid)
            return
        title, options = checked
        code = new_code()
        host_token = secrets.token_urlsafe(24)
        polls[code] = {
            "host_token": host_token,
            "host_sid": sid,
            "title": title,
            "options": options,
            "state": "lobby",
            "voters": {},
            "created": time.time(),
        }
        _save(code)
        await sio.emit("poll_created", {"code": code, "host_token": host_token}, to=sid)
        await _update_host(code)

    @sio.event
    @admin_only
    async def reconnect_poll_host(sid, data):
        code = str((data or {}).get("code") or "").upper()
        poll = polls.get(code)
        if not poll or not secrets.compare_digest(str((data or {}).get("token") or ""), poll["host_token"]):
            await sio.emit("poll_reconnect_failed", {}, to=sid)
            return
        poll["host_sid"] = sid
        await _update_host(code)

    @sio.event
    @admin_only
    async def update_poll_options(sid, data):
        """Optionen nachträglich ändern – nur solange noch niemand abstimmen konnte."""
        code = str((data or {}).get("code") or "").upper()
        poll = polls.get(code)
        if not _is_host(poll, sid):
            return
        if poll["state"] != "lobby":
            await sio.emit("poll_error", {"message": "Die Abstimmung läuft schon"}, to=sid)
            return
        checked = validate_options(data)
        if isinstance(checked, str):
            await sio.emit("poll_error", {"message": checked}, to=sid)
            return
        poll["title"], poll["options"] = checked
        _save(code)
        await sio.emit("poll_options", {"title": poll["title"], "options": poll["options"]}, room=f"poll:{code}")
        await _update_host(code)

    @sio.event
    @admin_only
    async def open_poll(sid, data):
        code = str((data or {}).get("code") or "").upper()
        poll = polls.get(code)
        if not _is_host(poll, sid) or poll["state"] == "open":
            return
        poll["state"] = "open"
        _save(code)
        await sio.emit("poll_state", {"state": "open"}, room=f"poll:{code}")
        await _update_host(code)

    @sio.event
    @admin_only
    async def close_poll(sid, data):
        code = str((data or {}).get("code") or "").upper()
        poll = polls.get(code)
        if not _is_host(poll, sid) or poll["state"] != "open":
            return
        poll["state"] = "closed"
        _save(code)
        await sio.emit("poll_state", {"state": "closed", "results": results(poll)}, room=f"poll:{code}")
        await _update_host(code)

    @sio.event
    @admin_only
    async def delete_poll(sid, data):
        code = str((data or {}).get("code") or "").upper()
        poll = polls.get(code)
        if not _is_host(poll, sid):
            return
        polls.pop(code, None)
        db.delete_poll(code)
        await sio.emit("poll_deleted", {"message": "Die Abstimmung wurde beendet."}, room=f"poll:{code}")

    @sio.event
    async def cast_vote(sid, data):
        code = str((data or {}).get("code") or "").upper()
        poll = polls.get(code)
        if not poll:
            return
        _, voter = _find_voter_by_sid(poll, sid)
        if voter is None:
            return
        if poll["state"] != "open":
            msg = "Die Abstimmung ist schon beendet" if poll["state"] == "closed" else "Die Abstimmung hat noch nicht begonnen"
            await sio.emit("error", {"message": msg}, to=sid)
            return
        option = (data or {}).get("option")
        if not isinstance(option, int) or isinstance(option, bool) or not 0 <= option < len(poll["options"]):
            return
        voter["vote"] = option
        _save(code)
        await sio.emit("vote_saved", {"option": option}, to=sid)
        await _update_host(code)
