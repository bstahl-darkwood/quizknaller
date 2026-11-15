"""
SmartQuiz – Admin-Login für Host, Abstimmung und Creator.

- Passwort kommt aus der Umgebungsvariable ADMIN_PASSWORD (Produktion: ~/quizknaller/.env, nicht im Git).
- Nach dem Login gibt es ein signiertes Cookie (30 Tage gültig). Der Schlüssel wird aus dem Passwort
  abgeleitet: Passwort ändern meldet alle Geräte ab, ein Neustart/Deploy nicht.
- Geschützt sind die Seiten (/host, /vote, /creator) UND alle Host-Befehle über Socket.IO –
  sonst könnte jemand die Befehle auch ohne Seite direkt schicken.
- Ohne ADMIN_PASSWORD (lokale Entwicklung) ist der Login aus. Mit REQUIRE_LOGIN=1 startet die App
  dann gar nicht erst.
"""

from __future__ import annotations

import functools
import hashlib
import hmac
import os
import secrets
import time
from http.cookies import SimpleCookie

ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
if os.environ.get("REQUIRE_LOGIN") and len(ADMIN_PASSWORD) < 8:
    raise SystemExit("ADMIN_PASSWORD fehlt oder ist kürzer als 8 Zeichen (siehe ANLEITUNG.md, Abschnitt Login)")

ENABLED = bool(ADMIN_PASSWORD)
COOKIE_NAME = "sq_admin"
SESSION_SECONDS = 30 * 24 * 3600
_KEY = hashlib.sha256(b"smartquiz-admin-session\0" + ADMIN_PASSWORD.encode()).digest()

# Bremse gegen Passwort-Raten: höchstens MAX_FAILS Fehlversuche pro IP in LOCK_SECONDS
MAX_FAILS = 8
LOCK_SECONDS = 15 * 60
_fails: dict[str, list[float]] = {}

# Socket-Verbindungen, die beim Verbinden ein gültiges Admin-Cookie mitgebracht haben
admin_sids: set[str] = set()


def _sign(payload: str) -> str:
    return hmac.new(_KEY, payload.encode(), hashlib.sha256).hexdigest()


def new_session() -> str:
    payload = f"{int(time.time()) + SESSION_SECONDS}.{secrets.token_urlsafe(9)}"
    return f"{payload}.{_sign(payload)}"


def valid_session(token: str | None) -> bool:
    if not ENABLED:
        return True
    try:
        expires, nonce, sig = str(token or "").split(".")
        if not hmac.compare_digest(sig, _sign(f"{expires}.{nonce}")):
            return False
        return int(expires) > time.time()
    except ValueError:
        return False


def check_password(password: str) -> bool:
    return ENABLED and hmac.compare_digest(
        hashlib.sha256(password.encode()).digest(), hashlib.sha256(ADMIN_PASSWORD.encode()).digest()
    )


def locked(ip: str) -> bool:
    now = time.time()
    recent = [t for t in _fails.get(ip, []) if now - t < LOCK_SECONDS]
    if recent:
        _fails[ip] = recent
    else:
        _fails.pop(ip, None)
    return len(recent) >= MAX_FAILS


def record_failure(ip: str):
    _fails.setdefault(ip, []).append(time.time())
    if len(_fails) > 10_000:  # Speicher begrenzen
        _fails.clear()


def clear_failures(ip: str):
    _fails.pop(ip, None)


def session_from_environ(environ: dict) -> bool:
    """Für Socket.IO: Cookie aus dem Verbindungsaufbau lesen."""
    if not ENABLED:
        return True
    cookie = SimpleCookie()
    try:
        cookie.load(environ.get("HTTP_COOKIE", ""))
    except Exception:
        return False
    morsel = cookie.get(COOKIE_NAME)
    return valid_session(morsel.value if morsel else None)


def admin_only(sio):
    """Decorator-Fabrik für Host-Befehle: ohne Admin-Login wird der Befehl ignoriert."""
    def decorate(handler):
        @functools.wraps(handler)
        async def wrapper(sid, data=None):
            if sid not in admin_sids:
                await sio.emit("auth_required", {"message": "Bitte als Admin anmelden"}, to=sid)
                return None
            return await handler(sid, data)
        return wrapper
    return decorate
