#!/usr/bin/env bash
# Build the MTA and deploy it to the targeted client space.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

CLIENT="${1:-}"
[ -n "$CLIENT" ] || die "Usage: deploy.sh <client>"
DIR="$(client_dir "$CLIENT")"
CONFIG="$DIR/client.yaml"

need cf "Install the Cloud Foundry CLI"
need mbt "Install: npm i -g mbt"
cf plugins 2>/dev/null | grep -qi multiapps || die "multiapps plugin missing. Run: cf install-plugin multiapps -f"

assert_cf_target "$(yaml_get "$CONFIG" cloudfoundry.org)" "$(yaml_get "$CONFIG" cloudfoundry.space)"

step "Validating router configuration"
node "$FP_CAP/scripts/validate-xs-app.js" || die "xs-app.json would be rejected by the approuter"

step "Building MTA"
( cd "$FP_CAP" && rm -rf mta_archives gen && mbt build -p=cf ) >/dev/null 2>&1 \
  || die "mbt build failed — run it manually in apps/cap to see why"
ARCHIVE=$(ls -t "$FP_CAP"/mta_archives/*.mtar 2>/dev/null | head -1)
[ -n "$ARCHIVE" ] || die "No .mtar produced"
ok "built $(basename "$ARCHIVE")"

step "Deploying"
# The MTA client sometimes reports failure while the apps are still starting,
# so the app state below — not this exit code — is what decides.
cf deploy "$ARCHIVE" -f || warn "cf deploy reported a failure; checking actual app state"

step "Verifying app state"
sleep 5
FAILED=0
for app in factorypilot-srv factorypilot-approuter; do
  state=$(cf app "$app" 2>/dev/null | awk '/^#0/{print $2}')
  if [ "$state" = "running" ]; then
    ok "$app running"
  else
    warn "$app is '${state:-unknown}'"
    FAILED=1
  fi
done
[ "$FAILED" -eq 0 ] || die "Applications are not healthy. Check: cf logs factorypilot-srv --recent"

APPROUTER_URL=$(cf app factorypilot-approuter 2>/dev/null | awk '/routes:/{print $2}')
[ -n "$APPROUTER_URL" ] && ok "https://$APPROUTER_URL"
