#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
HOST="${DAILY_HOST:-127.0.0.1}"
PORT="${DAILY_PORT:-8090}"
PYTHON_BIN="python3"
if [[ -x ".venv/bin/python" ]]; then
  PYTHON_BIN=".venv/bin/python"
fi
echo "Starting Daily v0.1 -> http://${HOST}:${PORT}  (DB: ${DAILY_DB_PATH:-$HOME/.local/share/daily/daily.db}, Python: ${PYTHON_BIN})"
exec "$PYTHON_BIN" -m uvicorn daily.app:app --host "$HOST" --port "$PORT"
