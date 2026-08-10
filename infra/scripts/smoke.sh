#!/usr/bin/env bash
# Post-deploy verification for a client landscape.
#
# Checks what can be checked without a user session. Anything needing a logged
# in browser is reported as a manual step rather than silently passed.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

CLIENT="${1:-}"
[ -n "$CLIENT" ] || die "Usage: smoke.sh <client>"
DIR="$(client_dir "$CLIENT")"
CONFIG="$DIR/client.yaml"

assert_cf_target "$(yaml_get "$CONFIG" cloudfoundry.org)" "$(yaml_get "$CONFIG" cloudfoundry.space)"

PASS=0; FAIL=0
pass() { ok "$*"; PASS=$((PASS+1)); }
fail() { _c '0;31' "  ✗ $*"; FAIL=$((FAIL+1)); }

step "Applications"
for app in factorypilot-srv factorypilot-approuter; do
  state=$(cf app "$app" 2>/dev/null | awk '/^#0/{print $2}')
  [ "$state" = "running" ] && pass "$app running" || fail "$app is '${state:-missing}'"
done

state=$(cf app factorypilot-db-deployer 2>/dev/null | awk '/^#0/{print $2}')
# The deployer is a one-off task, so it having exited is the success case. CF
# reports a finished task app's instance as "down" rather than "stopped", and
# an absent row is equally fine — only "running" would be wrong.
case "${state:-none}" in
  running) fail "db-deployer is still running — it should exit after deploying the schema" ;;
  *)       pass "db-deployer finished (state: ${state:-none})" ;;
esac

step "Services"
for svc in factorypilot-auth factorypilot-db; do
  cf service "$svc" >/dev/null 2>&1 && pass "$svc exists" || fail "$svc missing"
done
cf service factorypilot-redis >/dev/null 2>&1 \
  && pass "factorypilot-redis exists" \
  || warn "no Redis — the in-process cache will be used (single instance only)"

step "Endpoints"
AR=$(cf app factorypilot-approuter 2>/dev/null | awk '/routes:/{print $2}')
if [ -n "$AR" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "https://$AR/insights/index.html")
  # 200 means the shell is served; 302/401 means auth is enforcing. Both prove
  # the approuter is answering. A 5xx or no answer does not.
  case "$code" in
    200|302|401) pass "approuter answering (HTTP $code)" ;;
    *) fail "approuter returned HTTP $code" ;;
  esac
else
  fail "approuter has no route"
fi

SRV=$(cf app factorypilot-srv 2>/dev/null | awk '/routes:/{print $2}')
if [ -n "$SRV" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "https://$SRV/odata/config/\$metadata")
  case "$code" in
    200|401) pass "CAP services answering (HTTP $code)" ;;
    *) fail "CAP metadata returned HTTP $code" ;;
  esac
fi

step "Services registered"
count=$(cf logs factorypilot-srv --recent 2>/dev/null | grep -aoE 'serving [A-Za-z]+Service' | sort -u | wc -l | xargs)
[ "${count:-0}" -ge 5 ] && pass "$count CAP services serving" || fail "only ${count:-0} services serving"

step "Secrets"
for var in OPENROUTER_API_KEY CPI_CLIENT_ID CPI_CLIENT_SECRET; do
  # Presence only — the value is never printed.
  cf env factorypilot-srv 2>/dev/null | grep -q "\"$var\"\|^$var:" \
    && pass "$var is set" \
    || warn "$var not set (that feature will fall back or fail)"
done

printf '\n'
step "Manual steps this script cannot verify"
info "role collections assigned to real users (otherwise: authenticated, then 403)"
info "iFlow endpoints tested from the Integration console"

printf '\n  %d passed, %d failed\n\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
