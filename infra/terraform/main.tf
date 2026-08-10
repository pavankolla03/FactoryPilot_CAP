/**
 * Long-lived services for one FactoryPilot client landscape.
 *
 * Terraform owns what exists between releases: identity, database, cache,
 * destinations. It deliberately does NOT push applications — those change with
 * every release and belong to deploy.sh, where a bad build is a rollback
 * rather than a state-file conflict (ADR-014).
 */

data "cloudfoundry_org" "this" {
  name = var.cf_org
}

data "cloudfoundry_space" "this" {
  name = var.cf_space
  org  = data.cloudfoundry_org.this.id
}

# --- identity ----------------------------------------------------------------

data "cloudfoundry_service" "xsuaa" {
  name = "xsuaa"
}

resource "cloudfoundry_service_instance" "auth" {
  name         = "factorypilot-auth"
  space        = data.cloudfoundry_space.this.id
  service_plan = data.cloudfoundry_service.xsuaa.service_plans["application"]

  # xsappname is scoped per org and space so two landscapes in one subaccount
  # cannot collide on the same OAuth client.
  parameters = jsonencode(merge(
    jsondecode(file("${path.module}/../../apps/cap/xs-security.json")),
    {
      xsappname = "factorypilot-${var.cf_org}-${var.cf_space}"
      oauth2-configuration = {
        token-validity         = 900
        refresh-token-validity = 1800
        autoapprove            = true
        redirect-uris          = var.redirect_uris
      }
    }
  ))
}

# --- database ----------------------------------------------------------------

data "cloudfoundry_service" "postgres" {
  count = var.db_engine == "postgres" ? 1 : 0
  name  = "postgresql-db"
}

resource "cloudfoundry_service_instance" "db_postgres" {
  count        = var.db_engine == "postgres" ? 1 : 0
  name         = "factorypilot-db"
  space        = data.cloudfoundry_space.this.id
  service_plan = data.cloudfoundry_service.postgres[0].service_plans[var.db_plan]

  timeouts {
    create = "30m" # trial Postgres provisioning is routinely slow
    delete = "30m"
  }
}

data "cloudfoundry_service" "hana" {
  count = var.db_engine == "hana" ? 1 : 0
  name  = "hana"
}

resource "cloudfoundry_service_instance" "db_hana" {
  count        = var.db_engine == "hana" ? 1 : 0
  name         = "factorypilot-db"
  space        = data.cloudfoundry_space.this.id
  service_plan = data.cloudfoundry_service.hana[0].service_plans["hdi-shared"]

  timeouts {
    create = "30m"
    delete = "30m"
  }
}

# --- cache -------------------------------------------------------------------

data "cloudfoundry_service" "redis" {
  count = var.cache_engine == "redis" ? 1 : 0
  name  = "redis-cache"
}

# Optional on purpose: with no Redis the runtime falls back to an in-process
# cache, which is correct for a single instance. A client without the
# entitlement can still run the product.
resource "cloudfoundry_service_instance" "redis" {
  count        = var.cache_engine == "redis" ? 1 : 0
  name         = "factorypilot-redis"
  space        = data.cloudfoundry_space.this.id
  service_plan = data.cloudfoundry_service.redis[0].service_plans[var.redis_plan]

  timeouts {
    create = "30m"
    delete = "30m"
  }
}

# --- destinations ------------------------------------------------------------

data "cloudfoundry_service" "destination" {
  count = var.create_destination_service ? 1 : 0
  name  = "destination"
}

resource "cloudfoundry_service_instance" "destination" {
  count        = var.create_destination_service ? 1 : 0
  name         = "factorypilot-destination"
  space        = data.cloudfoundry_space.this.id
  service_plan = data.cloudfoundry_service.destination[0].service_plans["lite"]
}
