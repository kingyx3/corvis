variable "zone_id" {
  description = "Cloudflare zone ID for the single shared Corvis root domain."
  type        = string
}

variable "zone_name" {
  description = "Single Cloudflare root zone shared by UAT and production. Environment hostnames are derived as first-level labels."
  type        = string

  validation {
    condition = (
      trimspace(var.zone_name) != "" &&
      lower(trimspace(var.zone_name)) == trimspace(var.zone_name) &&
      !startswith(trimspace(var.zone_name), "http://") &&
      !startswith(trimspace(var.zone_name), "https://") &&
      !strcontains(trimspace(var.zone_name), "/") &&
      !strcontains(trimspace(var.zone_name), "*") &&
      length(split(".", trimspace(var.zone_name))) >= 2
    )
    error_message = "zone_name must be a lowercase root DNS zone name such as example.com, without scheme, path or wildcard."
  }
}

variable "api_requests_per_minute" {
  description = "Per-IP edge request ceiling for API traffic. Free uses one path-scoped rule; Pro+ mode uses separate hostname-scoped rules for prod and UAT. Application-level distributed limits remain authoritative per environment."
  type        = number
  default     = 300

  validation {
    condition     = var.api_requests_per_minute >= 30
    error_message = "api_requests_per_minute must be at least 30."
  }
}

variable "enable_managed_waf" {
  description = "Enable Cloudflare Managed/OWASP rules on Pro or higher. This also enables two hostname-scoped rate-limit rules, matching the two-rule Pro entitlement; false retains the Free-compatible one-rule baseline."
  type        = bool
  default     = false
}
