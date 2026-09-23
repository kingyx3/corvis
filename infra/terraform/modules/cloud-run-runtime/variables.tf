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
  description = "Immutable application image reference. Empty leaves API/worker runtimes unprovisioned until image promotion is configured."
  type        = string
  default     = ""
}

variable "api_service_account_email" {
  type = string
}

variable "worker_service_account_email" {
  type = string
}

variable "source_bucket_name" {
  type = string
}

variable "processing_topic_name" {
  type = string
}

variable "processing_dead_letter_topic_name" {
  type = string
}

variable "processing_queue_name" {
  type = string
}

variable "auth_issuer" {
  description = "Production OIDC issuer URL."
  type        = string
  default     = ""
}

variable "auth_audience" {
  description = "Production OIDC audience/client identifier."
  type        = string
  default     = "corvis"
}

variable "auth_jwks_url" {
  description = "Optional explicit JWKS URL for OIDC providers without standard discovery."
  type        = string
  default     = ""
}

variable "upload_allowed_origins" {
  description = "Allowed customer/admin browser origins for direct GCS upload initiation."
  type        = list(string)
  default     = []
}

variable "browser_allowed_origins" {
  description = "Public customer/admin browser origins allowed to issue state-changing API requests (CSRF Origin allow-list)."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for origin in var.browser_allowed_origins : can(regex("^https://[a-z0-9.-]+$", origin))])
    error_message = "browser_allowed_origins entries must be bare https:// origins without paths or trailing slashes."
  }
}

variable "postgres_dsn_secret_id" {
  description = "Secret Manager secret id containing the runtime Postgres DSN."
  type        = string
  default     = "corvis-postgres-dsn"
}

variable "postgres_ca_cert" {
  description = "Optional PEM CA certificate bundle trusted for Postgres TLS (public certificate material, not a secret). Empty uses Node's default trust store."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.postgres_ca_cert) == "" || strcontains(var.postgres_ca_cert, "-----BEGIN CERTIFICATE-----")
    error_message = "postgres_ca_cert must be empty or contain PEM-encoded certificates."
  }
}

variable "decommission_mode" {
  description = "Explicit lifecycle switch used only by the guarded decommission workflow to remove production deletion protection before teardown."
  type        = bool
  default     = false
}
