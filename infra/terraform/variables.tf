variable "cf_api_url" {
  description = "Cloud Foundry API endpoint for the client subaccount"
  type        = string
}

variable "cf_org" {
  description = "Cloud Foundry org"
  type        = string
}

variable "cf_space" {
  description = "Cloud Foundry space"
  type        = string
}

variable "client_id" {
  description = "Short client identifier, used in resource naming"
  type        = string
}

variable "db_engine" {
  description = "postgres | hana"
  type        = string
  default     = "postgres"

  validation {
    condition     = contains(["postgres", "hana"], var.db_engine)
    error_message = "db_engine must be postgres or hana."
  }
}

variable "xsuaa_plan" {
  description = "Service plan for the xsuaa offering"
  type        = string
  default     = "application"
}

variable "db_plan" {
  description = "Service plan for the database offering"
  type        = string
  default     = "trial"
}

variable "cache_engine" {
  description = "redis | memory. memory provisions nothing and is single-instance only."
  type        = string
  default     = "redis"

  validation {
    condition     = contains(["redis", "memory"], var.cache_engine)
    error_message = "cache_engine must be redis or memory."
  }
}

variable "redis_plan" {
  description = "Service plan for redis-cache"
  type        = string
  default     = "trial"
}

variable "redirect_uris" {
  description = "OAuth callback URIs XSUAA will accept. Without the approuter's own URL here, login fails at the callback with 'the request for authorization was invalid'."
  type        = list(string)
  default     = ["https://*.hana.ondemand.com/**"]
}

variable "create_destination_service" {
  description = "Provision a destination service instance for S/4 connectivity"
  type        = bool
  default     = true
}
