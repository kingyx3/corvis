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

variable "surface" {
  description = "Presentation-only runtime surface."
  type        = string
  default     = "customer"
  validation {
    condition     = contains(["customer", "admin"], var.surface)
    error_message = "surface must be customer or admin"
  }
}

variable "image" {
  description = "Immutable presentation web image. Empty leaves the runtime unprovisioned."
  type        = string
  default     = ""
}

variable "decommission_mode" {
  type    = bool
  default = false
}
