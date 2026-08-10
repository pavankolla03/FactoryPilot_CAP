terraform {
  required_version = ">= 1.6"

  required_providers {
    cloudfoundry = {
      source  = "cloudfoundry/cloudfoundry"
      version = "~> 1.0"
    }
  }
}

provider "cloudfoundry" {
  api_url = var.cf_api_url
  # Credentials come from the environment, never from a tfvars file that could
  # be committed: CF_USER / CF_PASSWORD, or an existing `cf login` session via
  # CF_SSO_PASSCODE. Nothing here holds a secret.
}
