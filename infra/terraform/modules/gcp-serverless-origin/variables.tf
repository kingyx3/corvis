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
    error_message = "environment must be uat or prod"
  }
}

variable "cloud_run_service_name" {
  description = "Cloud Run service name behind the serverless NEG."
  type        = string
}

variable "hostname" {
  description = "Public API hostname presented by the external HTTPS load balancer."
  type        = string
}

variable "dns_authorization_id" {
  description = "Certificate Manager DNS authorization resource ID for hostname."
  type        = string
}

variable "cloudflare_origin_cidrs" {
  description = "Current Cloudflare proxy egress CIDRs permitted to reach the API origin."
  type        = list(string)

  validation {
    condition     = length(var.cloudflare_origin_cidrs) > 0
    error_message = "cloudflare_origin_cidrs must contain at least one Cloudflare proxy range; origin exposure fails closed."
  }
}
