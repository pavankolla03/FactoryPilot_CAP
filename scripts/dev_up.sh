#!/usr/bin/env bash
# Bring the whole MVP up locally: CAP admin + orchestrator + Insights UI.
#
# No SAP account, no BTP, no Docker required — SQLite, an in-process cache and
# the synthetic S/4 fixture cover everything by default.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PY="${PY:-$ROOT/.venv/bin/python}"
CAP_PORT="${CAP_PORT:-4004}"
API_PORT="${API_PORT:-8080}"

log() { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[ -x "$PY" ] || die "No venv at $PY. Run: python3 -m venv .venv && .venv/bin/pip install -r services/orchestrator/requirements-dev.txt"

if [ ! -f apps/admin-cap/db/factorypilot.db ]; then
  log "Deploying CAP schema + seed data to SQLite"
  (cd apps/admin-cap && npm install --silent --no-audit --no-fund && npx cds deploy --to sqlite:db/factorypilot.db)
fi

cleanup() {
  log "Stopping"
  [ -n "${CAP_PID:-}" ] && kill "$CAP_PID" 2>/dev/null || true
  [ -n "${API_PID:-}" ] && kill "$API_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

log "Starting CAP admin on :$CAP_PORT"
(cd apps/admin-cap && npx cds serve --port "$CAP_PORT" >"$ROOT/.data/cap.log" 2>&1) &
CAP_PID=$!

log "Starting orchestrator on :$API_PORT"
"$PY" -m uvicorn app.main:app --app-dir services/orchestrator --host 127.0.0.1 --port "$API_PORT" \
  >"$ROOT/.data/orchestrator.log" 2>&1 &
API_PID=$!

sleep 3
printf '\n'
log "Insights UI      http://localhost:$API_PORT/"
log "Insights API     http://localhost:$API_PORT/insights/query"
log "Admin console    http://localhost:$CAP_PORT/  (user: admin / password: admin)"
log "Logs             .data/cap.log, .data/orchestrator.log"
printf '\nPress Ctrl-C to stop.\n\n'

wait
