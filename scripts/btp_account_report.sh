#!/usr/bin/env bash
# Read-only survey of the Cloud Foundry target before any deploy.
#
# Nothing here changes state — it answers "what am I about to deploy into, and
# does this account actually entitle what mta.yaml asks for?"
set -uo pipefail

hr() { printf '\n\033[1;34m── %s\033[0m\n' "$*"; }
ok() { printf '  \033[0;32m✓\033[0m %s\n' "$*"; }
no() { printf '  \033[0;31m✗\033[0m %s\n' "$*"; }
info() { printf '  %s\n' "$*"; }

if ! cf oauth-token >/dev/null 2>&1; then
  no "Not logged in. Run: cf login --sso -a https://api.cf.us30.hana.ondemand.com"
  exit 1
fi

hr "Target"
cf target 2>/dev/null | sed 's/^/  /'

hr "Org quota (what the deploy has to fit inside)"
ORG=$(cf target 2>/dev/null | awk -F': *' '/^org:/{print $2}')
cf org "$ORG" 2>/dev/null | sed -n '1,20p' | sed 's/^/  /'

hr "Existing apps in this space"
APPS=$(cf apps 2>/dev/null | tail -n +4)
[ -n "$APPS" ] && echo "$APPS" | sed 's/^/  /' || info "(none)"

hr "Existing service instances"
SVCS=$(cf services 2>/dev/null | tail -n +4)
[ -n "$SVCS" ] && echo "$SVCS" | sed 's/^/  /' || info "(none)"

hr "Entitlements this deploy needs"
MARKET=$(cf marketplace 2>/dev/null)
check() {
  if echo "$MARKET" | grep -qiE "^$1[[:space:]]"; then
    ok "$1 — available ($(echo "$MARKET" | grep -iE "^$1[[:space:]]" | awk '{$1="";print $0}' | cut -c1-60 | xargs))"
  else
    no "$1 — NOT entitled"
  fi
}
check xsuaa
check postgresql-db
check hana
check destination
check html5-apps-repo

hr "Database decision"
if echo "$MARKET" | grep -qiE "^postgresql-db[[:space:]]"; then
  ok "PostgreSQL is entitled — mta.yaml works as written"
elif echo "$MARKET" | grep -qiE "^hana[[:space:]]"; then
  no "PostgreSQL is not entitled, but HANA is"
  info "Switch: swap the factorypilot-db resource in mta.yaml to the commented"
  info "HANA block, and point the deployer module at gen/db instead of gen/pg."
else
  no "Neither PostgreSQL nor HANA is entitled in this space"
  info "Options: enable an entitlement in the BTP cockpit, or register an"
  info "external Postgres as a user-provided service named factorypilot-db."
fi

hr "Full marketplace (for reference)"
echo "$MARKET" | tail -n +4 | sed 's/^/  /' | head -40

printf '\n'
