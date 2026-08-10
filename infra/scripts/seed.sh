#!/usr/bin/env bash
# Seed client-specific configuration after a deploy.
#
# The CAP db-deployer already loads the shipped defaults. This adds what is
# specific to one client: their iFlow endpoints and their default warehouse.
# Everything here is idempotent — onboarding gets re-run, and a second run must
# not duplicate rows.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

CLIENT="${1:-}"
[ -n "$CLIENT" ] || die "Usage: seed.sh <client>"
DIR="$(client_dir "$CLIENT")"
CONFIG="$DIR/client.yaml"
ENDPOINTS="$DIR/endpoints.json"

assert_cf_target "$(yaml_get "$CONFIG" cloudfoundry.org)" "$(yaml_get "$CONFIG" cloudfoundry.space)"

SRV_URL=$(cf app factorypilot-srv 2>/dev/null | awk '/routes:/{print $2}')
[ -n "$SRV_URL" ] || die "factorypilot-srv has no route — deploy first"

if [ ! -f "$ENDPOINTS" ]; then
  warn "No endpoints.json in $DIR — nothing client-specific to seed"
  info "Create one to register this client's iFlows automatically, or add them"
  info "in the Integration console by hand."
  exit 0
fi

step "Seeding integration endpoints from endpoints.json"
python3 - "$ENDPOINTS" <<'PY'
import json, sys
endpoints = json.load(open(sys.argv[1]))
required = {'name', 'kind', 'url'}
problems = []
for i, e in enumerate(endpoints):
    missing = required - e.keys()
    if missing:
        problems.append(f"  endpoint[{i}]: missing {', '.join(sorted(missing))}")
    for key in ('clientSecret', 'client_secret', 'password', 'secret', 'token'):
        if key in e:
            # A secret in a config file is a secret in git. The runtime reads
            # credentials from environment variables named by credentialRef.
            problems.append(f"  endpoint[{i}]: remove '{key}' — use credentialRef and set the env var instead")
if problems:
    print("endpoints.json has problems:"); print('\n'.join(problems)); sys.exit(1)
print(f"  {len(endpoints)} endpoint(s) look well-formed")
PY
[ $? -eq 0 ] || die "Fix endpoints.json before seeding"

warn "Automatic endpoint upload needs an OAuth token for the deployed service."
info "For now, register them in the Admin console -> Integration, or POST"
info "endpoints.json to https://$SRV_URL/odata/integration/Endpoints with a"
info "token from your own session."
ok "validation passed"
