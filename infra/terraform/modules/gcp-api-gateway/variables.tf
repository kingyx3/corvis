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
    error_message = "environment must be uat or prod for the public API gateway."
  }
}

variable "cloud_run_service_name" {
  description = "Cloud Run service name protected by IAM and invoked only by the gateway identity."
  type        = string
}

variable "cloud_run_service_uri" {
  description = "Cloud Run service URI used as the API Gateway backend address."
  type        = string
  sensitive   = true
}

variable "deployer_service_account_email" {
  description = "GitHub/WIF deployment identity that must be allowed to attach the gateway service account to API configs."
  type        = string
}
