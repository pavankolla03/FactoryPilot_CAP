#!/usr/bin/env bash
# Shared helpers for the onboarding scripts.
#
# Sourced, never executed directly.

set -uo pipefail

FP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FP_CAP="$FP_ROOT/apps/cap"
FP_CLIENTS="$FP_ROOT/infra/client-config"

_c() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
step() { _c '1;34' "▸ $*"; }
ok()   { _c '0;32' "  ✓ $*"; }
warn() { _c '0;33' "  ! $*"; }
die()  { _c '0;31' "  ✗ $*"; exit 1; }
info() { printf '    %s\n' "$*"; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is not installed. $2"
}

# Read a scalar out of client.yaml without requiring yq. The file is a flat
# two-level document by design, so a dependency-free reader is enough and one
# less thing a client has to install.
yaml_get() {
  local file="$1" path="$2"
  python3 - "$file" "$path" <<'PY'
import sys, re
file, path = sys.argv[1], sys.argv[2].split('.')
indent_of = lambda l: len(l) - len(l.lstrip())
lines = [l.rstrip('\n') for l in open(file) if l.strip() and not l.lstrip().startswith('#')]
depth, expect = 0, path[0]
for i, line in enumerate(lines):
    key = line.strip().split(':', 1)
    if len(key) < 2:
        continue
    name, value = key[0].strip(), key[1].strip()
    if name != expect or indent_of(line) != depth * 2:
        continue
    if depth == len(path) - 1:
        print(value.strip('"\''))
        break
    depth += 1
    expect = path[depth]
PY
}

# Confirm the CF CLI is pointed where the caller thinks it is. Deploying into
# the wrong org because a previous `cf target` was still active is the classic
# way to break someone else's landscape.
assert_cf_target() {
  local want_org="$1" want_space="$2"
  cf oauth-token >/dev/null 2>&1 || die "Not logged in. Run: cf login --sso -a <api-endpoint>"
  local org space
  org=$(cf target 2>/dev/null | awk -F': *' '/^org:/{print $2}' | xargs)
  space=$(cf target 2>/dev/null | awk -F': *' '/^space:/{print $2}' | xargs)
  [ "$org" = "$want_org" ] || die "CF is targeting org '$org' but client.yaml says '$want_org'. Run: cf target -o '$want_org' -s '$want_space'"
  [ "$space" = "$want_space" ] || die "CF is targeting space '$space' but client.yaml says '$want_space'. Run: cf target -o '$want_org' -s '$want_space'"
  ok "targeting $org / $space"
}

# Fail early when the client.yaml asks for a service the subaccount cannot
# provide — better than discovering it halfway through a deploy.
#
# The marketplace is fetched once and matched in memory. Piping `cf marketplace`
# into `grep -q` looks equivalent but is not: grep exits on the first match and
# closes the pipe, cf dies with SIGPIPE, and `set -o pipefail` turns that into a
# failed check — reporting "not entitled" for services that are entitled.
_FP_MARKETPLACE=""
_load_marketplace() {
  [ -n "$_FP_MARKETPLACE" ] && return 0
  _FP_MARKETPLACE="$(cf marketplace 2>/dev/null)"
  [ -n "$_FP_MARKETPLACE" ] || { warn "could not read the service marketplace"; return 1; }
}

assert_entitled() {
  local offering="$1"
  _load_marketplace || return 1
  if printf '%s\n' "$_FP_MARKETPLACE" | grep -iqE "^${offering}[[:space:]]"; then
    ok "$offering entitled"
    return 0
  fi
  warn "$offering is NOT in this subaccount's marketplace"
  return 1
}

client_dir() {
  local client="$1"
  local dir="$FP_CLIENTS/$client"
  [ -d "$dir" ] || die "No such client config: $dir (copy _template to start one)"
  printf '%s' "$dir"
}
