#!/usr/bin/env bash
# Provision the long-lived services for a client with Terraform.
#
# Terraform owns things that exist between releases — XSUAA, the database, the
# cache, destinations. It deliberately does not push applications: those change
# with every release and belong to deploy.sh, where a failure is a rollback
# rather than a state-file conflict (ADR-014).
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

CLIENT="${1:-}"
[ -n "$CLIENT" ] || die "Usage: provision.sh <client>"
DIR="$(client_dir "$CLIENT")"
CONFIG="$DIR/client.yaml"
TF_DIR="$FP_ROOT/infra/terraform"
TFVARS="$DIR/terraform.tfvars"

need terraform "Install: https://developer.hashicorp.com/terraform/install"

if [ ! -f "$TFVARS" ]; then
  warn "No terraform.tfvars in $DIR — generating one from client.yaml"
  {
    echo "# Generated from client.yaml. Review before applying."
    echo "cf_api_url  = \"$(yaml_get "$CONFIG" cloudfoundry.api)\""
    echo "cf_org      = \"$(yaml_get "$CONFIG" cloudfoundry.org)\""
    echo "cf_space    = \"$(yaml_get "$CONFIG" cloudfoundry.space)\""
    echo "client_id   = \"$CLIENT\""
    echo "db_engine   = \"$(yaml_get "$CONFIG" adapters.db_engine)\""
    echo "cache_engine = \"$(yaml_get "$CONFIG" adapters.cache_engine)\""
  } > "$TFVARS"
  ok "wrote $TFVARS"
fi

# State lives beside the client config, so two clients can never share one
# state file and stomp on each other's infrastructure.
STATE="$DIR/terraform.tfstate"

step "terraform init"
terraform -chdir="$TF_DIR" init -input=false -upgrade >/dev/null || die "terraform init failed"
ok "initialised"

step "terraform validate"
terraform -chdir="$TF_DIR" validate || die "terraform validate failed"
ok "configuration valid"

step "terraform plan"
terraform -chdir="$TF_DIR" plan \
  -input=false \
  -var-file="$TFVARS" \
  -state="$STATE" \
  -out="$DIR/tfplan" || die "terraform plan failed"

# Applying creates billable resources in someone's account. That is not a thing
# to do because a script ran; it is a thing to do because a person said yes.
if [ "${FP_AUTO_APPROVE:-false}" != "true" ]; then
  printf '\n'
  read -r -p "  Apply this plan to $CLIENT? [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]] || { warn "aborted — nothing applied"; exit 1; }
fi

step "terraform apply"
terraform -chdir="$TF_DIR" apply -input=false -state="$STATE" "$DIR/tfplan" || die "terraform apply failed"
ok "provisioned"

terraform -chdir="$TF_DIR" output -state="$STATE" -json > "$DIR/outputs.json" 2>/dev/null \
  && ok "outputs written to $DIR/outputs.json"
