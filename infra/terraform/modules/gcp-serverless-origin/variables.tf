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

variable "allowed_source_ranges" {
  description = "Source CIDRs allowed to reach the public origin load balancer. Expected to be the current Cloudflare proxy IPv4 ranges derived from the Cloudflare provider."
  type        = list(string)

  validation {
    condition = (
      length(var.allowed_source_ranges) > 0 &&
      alltrue([for cidr in var.allowed_source_ranges : can(cidrnetmask(cidr))])
    )
    error_message = "allowed_source_ranges must contain at least one valid IPv4 CIDR."
  }
}
