variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "asia-southeast1"
}

variable "environment" {
  type = string
}

variable "surface" {
  description = "Presentation gateway surface."
  type        = string
  default     = "customer"
  validation {
    condition     = contains(["customer", "admin"], var.surface)
    error_message = "surface must be customer or admin"
  }
}

variable "cloud_run_service_name" {
  type = string
}

variable "cloud_run_service_uri" {
  type      = string
  sensitive = true
}

variable "deployer_service_account_email" {
  type = string
}
