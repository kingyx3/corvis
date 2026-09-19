variable "zone_id" {
  description = "Cloudflare zone ID for the Corvis domain."
  type        = string
}

variable "origin_ipv4_address" {
  description = "IPv4 address of the GCP external HTTPS load balancer origin."
  type        = string
}

variable "customer_hostname" {
  description = "Customer application hostname. Empty keeps that surface unpublished."
  type        = string
  default     = ""
}

variable "admin_hostname" {
  description = "Admin application hostname. Empty keeps that surface unpublished."
  type        = string
  default     = ""
}

variable "api_hostname" {
  description = "Public API hostname."
  type        = string

  validation {
    condition     = trimspace(var.api_hostname) != ""
    error_message = "api_hostname must be non-empty when the Cloudflare edge module is enabled."
  }
}

variable "api_requests_per_minute" {
  description = "Per-IP API request ceiling enforced at the Cloudflare edge."
  type        = number
  default     = 300

  validation {
    condition     = var.api_requests_per_minute >= 30
    error_message = "api_requests_per_minute must be at least 30."
  }
}

variable "enable_managed_waf" {
  description = "Deploy Cloudflare Managed and OWASP managed rulesets when the zone plan supports them."
  type        = bool
  default     = false
}
