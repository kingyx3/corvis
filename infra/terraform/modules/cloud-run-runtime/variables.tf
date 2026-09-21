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

variable "postgres_dsn_secret_id" {
  description = "Secret Manager secret id containing the runtime Postgres DSN."
  type        = string
  default     = "corvis-postgres-dsn"
}

variable "decommission_mode" {
  description = "Explicit lifecycle switch used only by the guarded decommission workflow to remove production deletion protection before teardown."
  type        = bool
  default     = false
}
