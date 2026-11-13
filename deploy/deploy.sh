#!/usr/bin/env bash
# Update auf dem Server: neuesten Code holen, bauen, neu starten, warten bis die App gesund ist.
#   cd ~/quizknaller && ./deploy/deploy.sh
# Hinweis: Ein Neustart beendet laufende Spiele (sie liegen im Arbeitsspeicher) – nicht während eines Quizabends ausrollen.
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE="docker compose -f docker-compose.prod.yml"

docker network inspect edge >/dev/null 2>&1 || { echo "Docker-Netz 'edge' fehlt: docker network create edge"; exit 1; }

echo "→ Code holen"
BEFORE="$(git rev-parse HEAD)"
git pull --ff-only
# Hat der Pull dieses Skript geändert, mit der neuen Fassung neu starten
if [ -z "${DEPLOY_REEXEC:-}" ] && ! git diff --quiet "$BEFORE" HEAD -- deploy/deploy.sh; then
  DEPLOY_REEXEC=1 exec "$0" "$@"
fi

echo "→ Bauen und starten"
$COMPOSE build --pull
$COMPOSE up -d --remove-orphans

echo "→ Warten auf die App"
for i in $(seq 1 30); do
  if $COMPOSE exec -T app python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/health', timeout=3)" 2>/dev/null; then
    echo "  App gesund"; break
  fi
  sleep 2
  [ "$i" = 30 ] && { echo "  App antwortet nicht – Logs:"; $COMPOSE logs --tail 50 app; exit 1; }
done

echo "→ Alte Images aufräumen"
docker image prune -f >/dev/null
$COMPOSE ps
