#!/usr/bin/env bash
#
# Pre-demo check. Run this the morning of the demo.
#
# It answers one question: if I open this in front of an audience right now,
# what breaks? Every check prints PASS, WARN or FAIL with the fix next to it,
# and the exit code is non-zero only when something would actually break the
# demo — a WARN is something you can live with.
#
#   ./scripts/demo-check.sh            # local demo path
#   ./scripts/demo-check.sh --remote   # also check the deployed BTP app
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CAP="$ROOT/apps/cap"
PORT="${DEMO_PORT:-4099}"
REMOTE=0
[ "${1:-}" = "--remote" ] && REMOTE=1

fails=0
warns=0
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
warn() { printf '  \033[33mWARN\033[0m  %s\n     → %s\n' "$1" "$2"; warns=$((warns+1)); }
fail() { printf '  \033[31mFAIL\033[0m  %s\n     → %s\n' "$1" "$2"; fails=$((fails+1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

cleanup() { [ -n "${SRV_PID:-}" ] && kill -9 "$SRV_PID" 2>/dev/null; rm -f "$LOG" 2>/dev/null; }
trap cleanup EXIT

head_ "Toolchain"
node_major=$(node -v 2>/dev/null | sed 's/v\([0-9]*\).*/\1/')
if [ -z "$node_major" ]; then fail "node is not on PATH" "install Node 20+"
elif [ "$node_major" -lt 20 ]; then fail "node $(node -v) is too old" "CAP 10 needs Node 20+"
else pass "node $(node -v)"; fi

if [ -d "$CAP/node_modules" ]; then pass "dependencies installed"
else fail "apps/cap/node_modules is missing" "cd apps/cap && npm ci"; fi

head_ "Data"
if [ -f "$CAP/db/factorypilot.db" ]; then pass "local database exists"
else fail "no local database" "cd apps/cap && npx cds deploy --to sqlite:db/factorypilot.db"; fi

if (cd "$CAP" && node scripts/validate-seeds.js >/dev/null 2>&1); then pass "seed data is internally consistent"
else fail "seed data is inconsistent" "cd apps/cap && node scripts/validate-seeds.js"; fi

missing_fixtures=""
for f in delivery material_stock material_document physical_inventory purchasing; do
  [ -f "$ROOT/docs/api/hub/$f/sample_response.synthetic.json" ] || missing_fixtures="$missing_fixtures $f"
done
if [ -z "$missing_fixtures" ]; then pass "all 5 demo fixtures present"
else fail "missing fixtures:$missing_fixtures" "node scripts/make-demo-fixtures.js"; fi

head_ "Tests"
if (cd "$CAP" && npm test >/dev/null 2>&1); then pass "test suite green"
else fail "tests are failing" "cd apps/cap && npm test"; fi

head_ "The demo itself (offline, no S/4 and no credentials)"
LOG=$(mktemp)
(cd "$CAP" && FACTORYPILOT_DEMO_MODE=1 CDS_REQUIRES_AUTH_KIND=dummy \
  npx cds serve --port "$PORT" >"$LOG" 2>&1) &
SRV_PID=$!

up=0
for _ in $(seq 1 45); do
  curl -sf "http://localhost:$PORT/insights/" >/dev/null 2>&1 && { up=1; break; }
  sleep 1
done

if [ "$up" -ne 1 ]; then
  fail "the server did not start on port $PORT" "see the log below"
  tail -20 "$LOG" | sed 's/^/       /'
else
  pass "server started on port $PORT"

  # Each of these is a line in the demo script. A question that answers
  # ungrounded is worse than one that fails: it looks fine on stage.
  while IFS='|' read -r question expected label; do
    body=$(curl -s -m 30 -X POST "http://localhost:$PORT/insights/ask" \
      -H 'Content-Type: application/json' \
      -d "{\"question\":\"$question\",\"warehouseID\":\"1000\",\"channel\":\"WEB\",\"conversationID\":\"preflight-$RANDOM\"}")
    verdict=$(printf '%s' "$body" | EXPECTED="$expected" node -e "
      let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
        try{
          const r=JSON.parse(s); const m=JSON.parse(r.metrics||'{}');
          const want=process.env.EXPECTED;
          if(r.status!==want) return console.log('FAIL|expected '+want+', got '+r.status+': '+String(r.answer||r.message||'').slice(0,80));
          // A write is supposed to stop here with a card and no data of its own.
          if(want==='AWAITING_APPROVAL')
            return console.log((r.pendingAction?'PASS|':'FAIL|')+(r.pendingAction?'stopped for confirmation, nothing executed':'no confirmation card returned'));
          if(!m.grounded) return console.log('WARN|answered without touching data');
          console.log('PASS|'+String(r.answer||'').replace(/\n/g,' ').slice(0,72));
        }catch(e){console.log('FAIL|unparseable response: '+s.slice(0,90))}
      })" 2>/dev/null)
    state=${verdict%%|*}; detail=${verdict#*|}
    case "$state" in
      PASS) pass "$label — $detail" ;;
      WARN) warn "$label — $detail" "check the endpoint bound to this object" ;;
      *)    fail "$label — $detail" "ask it in the UI and read the audit log" ;;
    esac
  done <<'QUESTIONS'
How many deliveries today?|SUCCESS|deliveries
How much stock do we have for P123?|SUCCESS|stock for one material
How much stock do we have?|SUCCESS|stock overall
Show me goods movements today|SUCCESS|goods movements
Which physical inventory counts are still open?|SUCCESS|physical inventory
What purchase orders are open?|SUCCESS|purchase orders
Move 250 units of P123 to shipping in warehouse 1000|AWAITING_APPROVAL|write proposes a confirmation
QUESTIONS

  for page in insights admin dashboard; do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/$page/index.html")
    [ "$code" = "200" ] && pass "/$page renders" || fail "/$page returned HTTP $code" "check apps/cap/app/$page"
  done
fi

head_ "Provider"
if [ -n "${OPENROUTER_API_KEY:-}" ]; then pass "OPENROUTER_API_KEY set — answers come from a real model"
else warn "no OPENROUTER_API_KEY" "the offline provider answers from real fixture data; fine for a demo, but say so"; fi

if [ "$REMOTE" -eq 1 ]; then
  head_ "Deployed BTP app"
  if ! command -v cf >/dev/null 2>&1; then
    fail "cf CLI not installed" "https://docs.cloudfoundry.org/cf-cli/install-go-cli.html"
  elif ! cf target >/dev/null 2>&1; then
    fail "not logged in to Cloud Foundry" "cf login --sso -a https://api.cf.us10-003.hana.ondemand.com"
  else
    pass "cf target: $(cf target | awk -F': +' '/^org|^space/{printf "%s ", $2}')"
    for app in factorypilot-srv factorypilot-approuter; do
      state=$(cf app "$app" 2>/dev/null | awk '/^#0/{print $2}')
      [ "$state" = "running" ] && pass "$app running" || fail "$app is '${state:-not found}'" "cf logs $app --recent"
    done
    env_dump=$(cf env factorypilot-srv 2>/dev/null)
    if printf '%s' "$env_dump" | grep -q FACTORYPILOT_DEMO_MODE; then
      pass "FACTORYPILOT_DEMO_MODE is set on the deployed app"
    else
      warn "deployed app is NOT in demo mode" "it will call the real iFlows; set demo mode if their credentials are not ready"
    fi
  fi
fi

head_ "Summary"
if [ "$fails" -gt 0 ]; then
  printf '  \033[31m%d blocking problem(s)\033[0m, %d warning(s). Fix the FAILs above before demoing.\n\n' "$fails" "$warns"
  exit 1
fi
printf '  \033[32mDemo path is ready\033[0m — %d warning(s), none blocking.\n\n' "$warns"
