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

variable "source_bucket_name" {
  type = string
}

variable "artifact_registry_repository" {
  type    = string
  default = "corvis"
}

variable "enforce_service_account_key_creation_disabled" {
  description = "Enforce the project organization policy that blocks creation of user-managed service-account keys."
  type        = bool
  default     = false
}

variable "enforce_service_account_key_upload_disabled" {
  description = "Enforce the project organization policy that blocks upload of external public keys to service accounts."
  type        = bool
  default     = false
}

variable "labels" {
  type    = map(string)
  default = {}
}
