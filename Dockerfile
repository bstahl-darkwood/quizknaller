FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.9.5 /uv /usr/local/bin/uv

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    QUIZ_DB_PATH=/data/quizknaller.db

RUN useradd --create-home --uid 1000 quiz \
    && mkdir -p /data && chown quiz:quiz /data

WORKDIR /app
# Abhängigkeiten zuerst (eigener Layer, wird nur bei Änderungen an pyproject/uv.lock neu gebaut)
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY main.py auth.py database.py poll.py quizzes.json ./
COPY static ./static

USER quiz
EXPOSE 8000

# Genau ein Prozess: die laufenden Spiele liegen im Arbeitsspeicher (mehrere Worker würden sie nicht teilen).
# --proxy-headers: hinter dem Proxy kommt https über X-Forwarded-Proto, sonst zeigt der QR-Code auf http://
# --no-access-log und --log-level warning: keine IP-Adressen der Mitspielenden in den Server-Protokollen
# (Uvicorn schreibt sonst jede WebSocket-Verbindung mit IP ins Log; Datenschutz, siehe /datenschutz)
CMD ["/opt/venv/bin/uvicorn", "main:socket_app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--proxy-headers", "--forwarded-allow-ips", "*", "--no-access-log", "--log-level", "warning"]
