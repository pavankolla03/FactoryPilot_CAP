/**
 * Long-lived services for one FactoryPilot client landscape.
 *
 * Terraform owns what exists between releases: identity, database, cache,
 * destinations. It deliberately does NOT push applications — those change with
 * every release and belong to deploy.sh, where a bad build is a rollback
 * rather than a state-file conflict (ADR-014).
 *
 * Written against cloudfoundry/cloudfoundry v1: service plans are looked up by
 * offering + plan name and referenced by id, and every managed instance needs
 * type = "managed". The v0 community provider used different names entirely.
 */

data "cloudfoundry_org" "this" {
  name = var.cf_org
}

data "cloudfoundry_space" "this" {
  name = var.cf_space
  org  = data.cloudfoundry_org.this.id
}

# --- identity ----------------------------------------------------------------

data "cloudfoundry_service_plan" "xsuaa" {
  name                  = var.xsuaa_plan
  service_offering_name = "xsuaa"
}

resource "cloudfoundry_service_instance" "auth" {
  name         = "factorypilot-auth"
  space        = data.cloudfoundry_space.this.id
  type         = "managed"
  service_plan = data.cloudfoundry_service_plan.xsuaa.id

  # xsappname is scoped per org and space so two landscapes in one subaccount
  # cannot collide on the same OAuth client.
  #
  # redirect-uris matters more than it looks: without the approuter's own URL
  # here, login succeeds and then fails at the callback with "the request for
  # authorization was invalid" — after the login page, so the authorize request
  # still looks healthy from outside.
  parameters = jsonencode(merge(
    jsondecode(file("${path.module}/../../apps/cap/xs-security.json")),
    {
      xsappname = "factorypilot-${var.cf_org}-${var.cf_space}"
      "oauth2-configuration" = {
        "token-validity"         = 900
        "refresh-token-validity" = 1800
        "autoapprove"            = true
        "redirect-uris"          = var.redirect_uris
      }
    }
  ))

  timeouts = {
    create = "15m"
    update = "15m"
    delete = "15m"
  }
}

# --- database ----------------------------------------------------------------

data "cloudfoundry_service_plan" "postgres" {
  count                 = var.db_engine == "postgres" ? 1 : 0
  name                  = var.db_plan
  service_offering_name = "postgresql-db"
}

resource "cloudfoundry_service_instance" "db_postgres" {
  count        = var.db_engine == "postgres" ? 1 : 0
  name         = "factorypilot-db"
  space        = data.cloudfoundry_space.this.id
  type         = "managed"
  service_plan = data.cloudfoundry_service_plan.postgres[0].id

  timeouts = {
    create = "45m" # trial Postgres provisioning is routinely slow and has failed at 30m
    update = "45m"
    delete = "45m"
  }
}

data "cloudfoundry_service_plan" "hana" {
  count                 = var.db_engine == "hana" ? 1 : 0
  name                  = "hdi-shared"
  service_offering_name = "hana"
}

resource "cloudfoundry_service_instance" "db_hana" {
  count        = var.db_engine == "hana" ? 1 : 0
  name         = "factorypilot-db"
  space        = data.cloudfoundry_space.this.id
  type         = "managed"
  service_plan = data.cloudfoundry_service_plan.hana[0].id

  timeouts = {
    create = "45m"
    update = "45m"
    delete = "45m"
  }
}

# --- cache -------------------------------------------------------------------

data "cloudfoundry_service_plan" "redis" {
  count                 = var.cache_engine == "redis" ? 1 : 0
  name                  = var.redis_plan
  service_offering_name = "redis-cache"
}

# Optional on purpose: with no Redis the runtime falls back to an in-process
# cache, which is correct for a single instance. A client without the
# entitlement can still run the product.
resource "cloudfoundry_service_instance" "redis" {
  count        = var.cache_engine == "redis" ? 1 : 0
  name         = "factorypilot-redis"
  space        = data.cloudfoundry_space.this.id
  type         = "managed"
  service_plan = data.cloudfoundry_service_plan.redis[0].id

  timeouts = {
    create = "45m"
    update = "45m"
    delete = "45m"
  }
}

# --- destinations ------------------------------------------------------------

data "cloudfoundry_service_plan" "destination" {
  count                 = var.create_destination_service ? 1 : 0
  name                  = "lite"
  service_offering_name = "destination"
}

resource "cloudfoundry_service_instance" "destination" {
  count        = var.create_destination_service ? 1 : 0
  name         = "factorypilot-destination"
  space        = data.cloudfoundry_space.this.id
  type         = "managed"
  service_plan = data.cloudfoundry_service_plan.destination[0].id

  timeouts = {
    create = "15m"
    update = "15m"
    delete = "15m"
  }
}
