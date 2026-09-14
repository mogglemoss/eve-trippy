#!/usr/bin/env bash
# Ship the working tree to a Docker host over ssh and (re)build the container.
#
#   TRIPPY_HOST=box ./deploy.sh              # rsync + docker compose up -d --build
#   TRIPPY_HOST=box ./deploy.sh register     # ...then register slash commands from the container
#   TRIPPY_HOST=box ./deploy.sh probe        # ...then read Tripwire from inside the container (no Discord)
#   TRIPPY_HOST=box ./deploy.sh logs         # tail the container log
#   TRIPPY_HOST=box ./deploy.sh use dev      # copy .env.dev (or .env.prod) over .env on the host and restart
#   TRIPPY_HOST=box ./deploy.sh use          # say which env is active
#
# Needs: ssh access to the host, Docker with the compose plugin there, and a
# filled-in .env in the remote directory (never copied by this script). Remote
# steps run under bash explicitly, whatever the login shell is. If docker is
# not on the remote PATH for non-interactive shells, set TRIPPY_DOCKER_PATH to
# its directory (e.g. "$HOME/.orbstack/bin" or /usr/local/bin).
set -euo pipefail
HOST="${TRIPPY_HOST:?set TRIPPY_HOST to the ssh host that runs Docker}"
DIR="${TRIPPY_REMOTE_DIR:-trippy}"
DOCKER_PATH="${TRIPPY_DOCKER_PATH:-}"
cd "$(dirname "$0")"

remote() { ssh "$HOST" /bin/bash -s -- "$DIR" "$DOCKER_PATH" "$@"; }

sync() {
  rsync -az --delete \
    --exclude node_modules --exclude dist --exclude .git --exclude .trippy \
    --exclude .cache --exclude '.env' --exclude '.env.*' \
    ./ "$HOST:$DIR/"
}

case "${1:-deploy}" in
  logs)
    exec ssh -t "$HOST" /bin/bash -s -- "$DIR" "$DOCKER_PATH" <<'REMOTE'
[ -n "$2" ] && export PATH="$2:$PATH"; cd "$1" && docker compose logs -f --tail 100 trippy
REMOTE
    ;;
  register|probe)
    sync
    remote "$1" <<'REMOTE'
[ -n "$2" ] && export PATH="$2:$PATH"; cd "$1"
docker compose build -q
case "$3" in
  register) docker compose run --rm trippy node dist/bot/register.js ;;
  probe)    docker compose run --rm trippy node dist/probe.js ;;
esac
REMOTE
    ;;
  use)
    remote "${2:-}" <<'REMOTE'
[ -n "$2" ] && export PATH="$2:$PATH"; cd "$1"
if [ -z "$3" ]; then
  for f in .env.dev .env.prod; do [ -f "$f" ] && cmp -s "$f" .env && { echo "active: $f"; exit 0; }; done
  echo "active: .env (matches neither .env.dev nor .env.prod)"; exit 0
fi
src=".env.$3"
[ -f "$src" ] || { echo "no $src on $(hostname)"; exit 1; }
cp "$src" .env && echo "switched to $src" && docker compose up -d 2>&1 | grep -E 'Recreated|Started|Running' | tail -1
docker compose logs --tail 3 trippy | grep -E 'INFO|ERROR' | cut -c1-140
REMOTE
    ;;
  deploy)
    sync
    remote <<'REMOTE'
[ -n "$2" ] && export PATH="$2:$PATH"; cd "$1"
if [ ! -f .env ]; then echo "No .env in $(pwd) — copy .env.example there and fill it in."; exit 1; fi
docker compose up -d --build
docker compose logs --tail 20 trippy
REMOTE
    ;;
  *)
    echo "usage: $0 [deploy|register|probe|logs|use [dev|prod]]" >&2
    exit 64
    ;;
esac
