#!/usr/bin/env bash
#
# Cut a release, but only when the claim a tag makes is actually true.
#
# A version tag is an assertion: "this commit is what runs, and it works." Most
# release scripts only check that the tag name is free. This one checks the
# assertion, because a tag on a commit that was never deployed and never driven
# is worse than no tag — someone will later trust it to say what production is.
#
#   ./scripts/release.sh v0.1.0-trial              # check, then tag locally
#   ./scripts/release.sh v0.1.0-trial --check-only # report and stop
#   ./scripts/release.sh v0.1.0-trial --skip-deploy-check
#
# Pushing the tag is left to you — it is the outward-facing step, and the
# command is printed at the end.
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CAP="$ROOT/apps/cap"
VERSION="${1:-}"
CHECK_ONLY=0
SKIP_DEPLOY=0
for a in "$@"; do
  case "$a" in
    --check-only)         CHECK_ONLY=1 ;;
    --skip-deploy-check)  SKIP_DEPLOY=1 ;;
  esac
done

blockers=0
warnings=0
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
warn() { printf '  \033[33mWARN\033[0m  %s\n     → %s\n' "$1" "$2"; warnings=$((warnings+1)); }
fail() { printf '  \033[31mFAIL\033[0m  %s\n     → %s\n' "$1" "$2"; blockers=$((blockers+1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

if [ -z "$VERSION" ] || [ "${VERSION:0:2}" = "--" ]; then
  echo "Usage: ./scripts/release.sh <version> [--check-only] [--skip-deploy-check]"
  echo "Example: ./scripts/release.sh v0.1.0-trial"
  exit 2
fi

echo "Release readiness for $VERSION"

# --- the tag itself ----------------------------------------------------------

head_ "Version"
if git -C "$ROOT" rev-parse "$VERSION" >/dev/null 2>&1; then
  fail "the tag $VERSION already exists" "choose another version, or delete it deliberately"
else
  pass "$VERSION is free"
fi

case "$VERSION" in
  v[0-9]*.[0-9]*.[0-9]*) pass "version looks like semver" ;;
  *) warn "\"$VERSION\" is not vMAJOR.MINOR.PATCH" "readable, but tooling that sorts versions will not order it" ;;
esac

# --- the tree ----------------------------------------------------------------

head_ "Working tree"
dirty=$(git -C "$ROOT" status --porcelain --untracked-files=no)
if [ -n "$dirty" ]; then
  fail "uncommitted changes to tracked files" "a tag must point at what is actually committed"
  printf '        %s\n' "$(echo "$dirty" | head -5 | tr '\n' ' ')"
else
  pass "no uncommitted changes"
fi

branch=$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)
pass "tagging $branch at $(git -C "$ROOT" rev-parse --short HEAD)"

# --- does it work ------------------------------------------------------------

head_ "Does it work"
if (cd "$CAP" && npm test >/tmp/fp-release-test.log 2>&1); then
  pass "unit and service tests green ($(grep -oE '^ℹ pass [0-9]+' /tmp/fp-release-test.log | grep -oE '[0-9]+') tests)"
else
  fail "tests are failing" "cd apps/cap && npm test"
fi

if (cd "$CAP" && node scripts/validate-seeds.js >/dev/null 2>&1 && npm run validate:router --silent >/dev/null 2>&1); then
  pass "seed data and router configuration valid"
else
  fail "seed or router validation failed" "cd apps/cap && node scripts/validate-seeds.js"
fi

# Behaviour, not just code: start an instance and drive it.
#
# Clear the local usage counters first. The suite spends about eight requests
# against the same daily allowance every earlier run shares, so on a developer
# machine it otherwise reports a rate limit as if it were a product fault.
# Local SQLite only — this never touches a deployed database.
PORT=4079
node -e "
  const {DatabaseSync}=require('node:sqlite');
  new DatabaseSync('$CAP/db/factorypilot.db').prepare('DELETE FROM factorypilot_token_Consumption').run();
" 2>/dev/null
LOG=$(mktemp)
(cd "$CAP" && CDS_REQUIRES_AUTH_KIND=dummy npx cds serve --port "$PORT" >"$LOG" 2>&1) &
SRV=$!
up=0
for _ in $(seq 1 60); do curl -sf "http://localhost:$PORT/insights/" >/dev/null 2>&1 && { up=1; break; }; sleep 1; done
if [ "$up" -eq 1 ] && node "$ROOT/scripts/e2e.js" --url "http://localhost:$PORT" >/tmp/fp-release-e2e.log 2>&1; then
  pass "end-to-end behaviour verified against a running instance"
else
  fail "end-to-end suite failed" "node scripts/e2e.js — see /tmp/fp-release-e2e.log"
  tail -12 /tmp/fp-release-e2e.log | sed 's/^/        /'
fi
kill -9 "$SRV" 2>/dev/null
kill -9 "$(lsof -ti :$PORT 2>/dev/null)" 2>/dev/null
rm -f "$LOG"

# --- is it what runs ---------------------------------------------------------

head_ "Is this what runs"
if [ "$SKIP_DEPLOY" -eq 1 ]; then
  warn "deployment check skipped" "the tag will not attest that this commit is deployed"
elif ! command -v cf >/dev/null 2>&1; then
  warn "cf CLI not installed" "cannot confirm the deployed app matches this commit"
else
  # `cf target` reads the local config file and succeeds with a dead session,
  # so it cannot tell you whether the CLI can actually talk to the platform.
  # Ask it something real, and separate "cannot look" from "not there" — a
  # release script that reports an expired token as a missing app sends you to
  # redeploy something that was never broken.
  app_out=$(cf app factorypilot-srv 2>&1)
  if echo "$app_out" | grep -qiE 'token expired|not logged in|authentication|Please log in'; then
    warn "Cloud Foundry session expired — cannot verify what is deployed" \
         "cf login --sso -a https://api.cf.us10-003.hana.ondemand.com, or pass --skip-deploy-check"
  elif echo "$app_out" | grep -qiE "App '.*' not found|not found"; then
    fail "factorypilot-srv is not deployed in $(cf target 2>/dev/null | awk -F': +' '/^space/{print $2}')" \
         "deploy before tagging, or pass --skip-deploy-check"
  else
  state=$(printf '%s' "$app_out" | awk '/^#0/{print $2}')
  if [ "$state" != "running" ]; then
    fail "factorypilot-srv is '${state:-in an unknown state}'" "deploy before tagging, or pass --skip-deploy-check"
  else
    # The app reports the commit it was built from when the deploy set it.
    deployed=$(cf env factorypilot-srv 2>/dev/null | grep -oE 'FP_GIT_SHA[": ]+[0-9a-f]{7,40}' | grep -oE '[0-9a-f]{7,40}$' | head -1)
    here=$(git -C "$ROOT" rev-parse HEAD)
    if [ -z "$deployed" ]; then
      warn "the deployed app does not report a commit" "set FP_GIT_SHA at deploy time so a tag can be checked against it"
    elif [ "${here:0:${#deployed}}" = "$deployed" ]; then
      pass "the deployed app is this commit ($deployed)"
    else
      fail "the deployed app is $deployed, not ${here:0:12}" "deploy this commit before tagging it as a release"
    fi
  fi
  fi
fi

# --- is it written down ------------------------------------------------------

head_ "Is it written down"
if grep -q "$VERSION" "$ROOT/CHANGELOG.md" 2>/dev/null; then
  pass "CHANGELOG.md has an entry for $VERSION"
else
  fail "CHANGELOG.md has no entry for $VERSION" "record what changed before tagging it"
fi

# --- decide ------------------------------------------------------------------

head_ "Decision"
if [ "$blockers" -gt 0 ]; then
  printf '  \033[31mNot ready\033[0m — %d blocking problem(s), %d warning(s).\n' "$blockers" "$warnings"
  printf '  A tag here would assert something untrue.\n\n'
  exit 1
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  printf '  \033[32mReady\033[0m — %d warning(s). Re-run without --check-only to tag.\n\n' "$warnings"
  exit 0
fi

git -C "$ROOT" tag -a "$VERSION" -m "FactoryPilot $VERSION

Verified before tagging:
  - unit and service tests green
  - end-to-end behaviour driven against a running instance
  - seed data and router configuration valid
  - CHANGELOG entry present"

printf '  \033[32mTagged\033[0m %s at %s (%d warning(s)).\n\n' "$VERSION" "$(git -C "$ROOT" rev-parse --short HEAD)" "$warnings"
echo "  Publishing is yours to do:"
echo "      git push origin $VERSION"
echo "      gh release create $VERSION --notes-from-tag"
echo
