variable "project_id" { type = string }

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

variable "source_bucket_name" { type = string }
variable "worker_service_account_email" { type = string }

variable "litellm_image" {
  description = "Immutable Corvis LiteLLM gateway image. Empty disables the AI runtime pair."
  type        = string
  default     = ""
}

variable "extractor_image" {
  description = "Immutable governed extraction-harness image. Empty disables the AI runtime pair."
  type        = string
  default     = ""
}

variable "litellm_models_json" {
  description = "Non-secret JSON mapping Corvis logical extraction aliases to provider/model identifiers."
  type        = string
  default     = ""
  sensitive   = false
}

variable "decommission_mode" {
  type    = bool
  default = false
}
