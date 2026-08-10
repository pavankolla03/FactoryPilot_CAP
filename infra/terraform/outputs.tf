output "xsuaa_instance" {
  description = "XSUAA service instance name to bind"
  value       = cloudfoundry_service_instance.auth.name
}

output "db_instance" {
  description = "Database service instance name to bind"
  value       = var.db_engine == "postgres" ? one(cloudfoundry_service_instance.db_postgres[*].name) : one(cloudfoundry_service_instance.db_hana[*].name)
}

output "cache_instance" {
  description = "Cache service instance name, or null when running on the in-process cache"
  value       = var.cache_engine == "redis" ? one(cloudfoundry_service_instance.redis[*].name) : null
}

output "space_id" {
  value = data.cloudfoundry_space.this.id
}

output "next_steps" {
  description = "What Terraform deliberately does not do"
  value = join("\n", [
    "1. ./infra/scripts/deploy.sh ${var.client_id}",
    "2. Assign role collections to users in the BTP cockpit",
    "3. cf set-env factorypilot-srv <SECRET_NAME> '<value>' && cf restage factorypilot-srv",
  ])
}
