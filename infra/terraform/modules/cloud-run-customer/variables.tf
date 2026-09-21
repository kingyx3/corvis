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

variable "image" {
  description = "Immutable customer web image. Empty leaves the customer runtime unprovisioned."
  type        = string
  default     = ""
}

variable "decommission_mode" {
  type    = bool
  default = false
}
