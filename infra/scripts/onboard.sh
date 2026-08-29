#!/usr/bin/env bash
# Onboard a client: provision -> deploy -> seed -> smoke.
#
#   ./infra/scripts/onboard.sh <client> [--skip-provision] [--dry-run]
#
# The whole point is that a new client is a config directory, not a fork. If
# this script needs editing to onboard someone, that is a bug in the product.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

CLIENT="${1:-}"
[ -n "$CLIENT" ] || die "Usage: onboard.sh <client> [--skip-provision] [--dry-run]"
shift || true

SKIP_PROVISION=false
DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --skip-provision) SKIP_PROVISION=true ;;
    --dry-run) DRY_RUN=true ;;
    *) die "Unknown option: $arg" ;;
  esac
done

DIR="$(client_dir "$CLIENT")"
CONFIG="$DIR/client.yaml"
[ -f "$CONFIG" ] || die "No client.yaml in $DIR"

ORG=$(yaml_get "$CONFIG" cloudfoundry.org)
SPACE=$(yaml_get "$CONFIG" cloudfoundry.space)
API=$(yaml_get "$CONFIG" cloudfoundry.api)
DB_ENGINE=$(yaml_get "$CONFIG" adapters.db_engine)
CACHE_ENGINE=$(yaml_get "$CONFIG" adapters.cache_engine)
LLM_PROVIDER=$(yaml_get "$CONFIG" adapters.llm_provider)

printf '\n'
step "Onboarding client: $CLIENT"
info "api        $API"
info "org/space  $ORG / $SPACE"
info "db         $DB_ENGINE"
info "cache      $CACHE_ENGINE"
info "llm        $LLM_PROVIDER"
printf '\n'

if [ "$DRY_RUN" = true ]; then
  warn "dry run — nothing will be created or deployed"
fi

# --- 1. preflight ------------------------------------------------------------
step "Preflight"
need cf "Install: https://docs.cloudfoundry.org/cf-cli/install-go-cli.html"
need node "Install Node 20+"
need python3 "Install Python 3"
assert_cf_target "$ORG" "$SPACE"

MISSING=0
assert_entitled xsuaa || MISSING=1
[ "$DB_ENGINE" = "postgres" ] && { assert_entitled postgresql-db || MISSING=1; }
[ "$DB_ENGINE" = "hana" ]     && { assert_entitled hana || MISSING=1; }
[ "$CACHE_ENGINE" = "redis" ] && { assert_entitled redis-cache || warn "redis-cache missing — the in-process cache will be used instead (single instance only)"; }
[ "$MISSING" -eq 1 ] && die "Required entitlements are missing. Enable them in the BTP cockpit, or change adapters in client.yaml."

# --- 2. provision ------------------------------------------------------------
if [ "$SKIP_PROVISION" = true ]; then
  step "Provision — skipped"
else
  step "Provision (Terraform)"
  if [ "$DRY_RUN" = true ]; then
    info "would run: infra/scripts/provision.sh $CLIENT"
  else
    "$FP_ROOT/infra/scripts/provision.sh" "$CLIENT" || die "Provisioning failed"
  fi
fi

# --- 3. deploy ---------------------------------------------------------------
step "Deploy"
if [ "$DRY_RUN" = true ]; then
  info "would run: infra/scripts/deploy.sh $CLIENT"
else
  "$FP_ROOT/infra/scripts/deploy.sh" "$CLIENT" || die "Deploy failed"
fi

# --- 4. seed -----------------------------------------------------------------
step "Seed client configuration"
if [ "$DRY_RUN" = true ]; then
  info "would run: infra/scripts/seed.sh $CLIENT"
else
  "$FP_ROOT/infra/scripts/seed.sh" "$CLIENT" || warn "Seeding reported problems — check before going live"
fi

# --- 5. smoke ----------------------------------------------------------------
step "Smoke test"
if [ "$DRY_RUN" = true ]; then
  info "would run: infra/scripts/smoke.sh $CLIENT"
else
  "$FP_ROOT/infra/scripts/smoke.sh" "$CLIENT" || die "Smoke test failed — the deployment is not usable yet"
fi

printf '\n'
step "Onboarded: $CLIENT"
cat <<EOF

  Two things this script cannot do, because they need a human:

  1. Assign role collections to real users
     BTP Cockpit -> Security -> Role Collections -> FactoryPilot_Admin
     Without this, users authenticate and then get 403 on every call.

  2. Set the secrets
     cf set-env factorypilot-srv OPENROUTER_API_KEY  '<key>'
     cf set-env factorypilot-srv CPI_CLIENT_ID       '<id>'
     cf set-env factorypilot-srv CPI_CLIENT_SECRET   '<secret>'
     cf restage factorypilot-srv

     Secrets are never written to client.yaml or to the database — the config
     stores only the NAME of the variable that holds each one.

EOF
