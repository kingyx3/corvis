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
    condition     = contains(["uat", "prod"], var.environment)
    error_message = "control-loop runtime is production-like and supports only uat or prod"
  }
}

variable "control_loop_image" {
  description = "Immutable control-loop image reference. Empty keeps the scheduled runtime unprovisioned."
  type        = string
  default     = ""
}

variable "service_account_email" {
  type = string
}

variable "state_bucket_name" {
  type = string
}

variable "decommission_mode" {
  description = "Explicit destructive lifecycle switch used only by the guarded decommission workflow."
  type        = bool
  default     = false
}
