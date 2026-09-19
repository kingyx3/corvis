variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "asia-southeast1"
}

variable "environment" {
  type = string
  validation {
    condition     = contains(["dev", "uat", "prod"], var.environment)
    error_message = "environment must be dev, uat, or prod"
  }
}

variable "api_image" {
  description = "Immutable API image reference (digest preferred). Empty leaves the runtime unprovisioned until image promotion is configured."
  type        = string
  default     = ""
}

variable "api_service_account_email" {
  type = string
}

variable "postgres_dsn_secret_id" {
  description = "Secret Manager secret id containing the runtime Postgres DSN."
  type        = string
  default     = "corvis-postgres-dsn"
}

variable "gateway_identity_secret_id" {
  description = "Secret Manager secret id containing the gateway identity verification secret."
  type        = string
  default     = "corvis-gateway-identity-secret"
}
