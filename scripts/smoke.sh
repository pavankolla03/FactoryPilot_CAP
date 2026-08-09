#!/usr/bin/env bash
# End-to-end smoke test against a running orchestrator.
#
# Exercises the six paths the delivery plan lists for Day 17:
#   connectivity, intent resolution, query success, cache hit,
#   rate-limit denial, and graceful failure on an unmatched question.
set -uo pipefail

BASE="${BASE:-http://127.0.0.1:8080}"
USER_ID="${USER_ID:-smoke-$RANDOM}"
ROLES="BusinessUser,InsightsQuery,InsightsReadOwnUsage"
PASS=0
FAIL=0

green() { printf '\033[0;32m✓\033[0m %s\n' "$*"; PASS=$((PASS + 1)); }
red()   { printf '\033[0;31m✗\033[0m %s\n' "$*"; FAIL=$((FAIL + 1)); }

ask() {
  curl -s -o /tmp/fp_smoke.json -w '%{http_code}' \
    -X POST "$BASE/insights/query" \
    -H 'Content-Type: application/json' \
    -H "X-User-Id: $USER_ID" -H "X-User-Roles: $ROLES" \
    -d "$1"
}

field() { python3 -c "import json,sys; d=json.load(open('/tmp/fp_smoke.json')); print(d.get('metadata',{}).get('$1', d.get('$1','')))"; }

printf '\nFactoryPilot smoke — %s (user %s)\n\n' "$BASE" "$USER_ID"

# 1 — connectivity
if [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/insights/health")" = "200" ]; then
  green "health endpoint responds"
else
  red "health endpoint unreachable — is the orchestrator running?"
  printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"; exit 1
fi

Q='{"questionText":"How many deliveries today in my warehouse?","filters":{"datePreset":"today","warehouse":"1000"}}'

# 2 + 3 — intent resolution and a successful answer
code=$(ask "$Q")
if [ "$code" = "200" ] && [ "$(field objectCode)" = "DELIVERY" ]; then
  green "query resolves to DELIVERY and returns an answer (intent: $(field intentMethod), $(field rowCount) rows)"
else
  red "first query failed — HTTP $code $(cat /tmp/fp_smoke.json | head -c 200)"
fi

# 4 — cache hit
code=$(ask "$Q")
if [ "$code" = "200" ] && [ "$(field cacheResult)" = "HIT" ]; then
  green "repeat query served from cache ($(field totalResponseTimeMs) ms)"
else
  red "expected a cache HIT on the repeat query, got $(field cacheResult)"
fi

# 5 — graceful failure on an unmatched question
code=$(ask '{"questionText":"what is the weather in Berlin"}')
if [ "$code" = "400" ] && [ "$(field errorCode)" = "INTENT_UNRESOLVED" ]; then
  green "unmatched question returns a clean 400, not a stack trace"
else
  red "expected 400 INTENT_UNRESOLVED, got HTTP $code"
fi

# 6 — rate-limit denial (fire past the seeded DEFAULT day limit)
limit=$(curl -s "$BASE/insights/usage/me" -H "X-User-Id: $USER_ID" -H "X-User-Roles: $ROLES" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['limits']['day'] or 0)")
if [ "$limit" -gt 0 ] && [ "$limit" -le 60 ]; then
  denied=0
  for _ in $(seq 1 "$((limit + 1))"); do
    code=$(ask "{\"questionText\":\"deliveries today $RANDOM\",\"filters\":{\"warehouse\":\"1000\"}}")
    [ "$code" = "429" ] && denied=1 && break
  done
  if [ "$denied" = "1" ]; then
    green "rate limit denies with 429 once the day quota is spent"
  else
    red "never hit 429 after $((limit + 1)) requests against a limit of $limit"
  fi
else
  printf '\033[0;33m•\033[0m skipped rate-limit check (day limit is %s)\n' "$limit"
fi

printf '\n%d passed, %d failed\n\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
