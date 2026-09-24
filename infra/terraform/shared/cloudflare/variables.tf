variable "cloudflare_zone_name" {
  description = "Single externally owned Cloudflare root zone shared by UAT and production."
  type        = string

  validation {
    condition = (
      trimspace(var.cloudflare_zone_name) != "" &&
      lower(trimspace(var.cloudflare_zone_name)) == trimspace(var.cloudflare_zone_name) &&
      !startswith(trimspace(var.cloudflare_zone_name), "http://") &&
      !startswith(trimspace(var.cloudflare_zone_name), "https://") &&
      !strcontains(trimspace(var.cloudflare_zone_name), "/") &&
      !strcontains(trimspace(var.cloudflare_zone_name), "*") &&
      length(split(".", trimspace(var.cloudflare_zone_name))) >= 2
    )
    error_message = "cloudflare_zone_name must be one lowercase root DNS zone name without scheme, path or wildcard."
  }
}

variable "enable_cloudflare_managed_waf" {
  description = "Enable Pro+ Cloudflare/OWASP managed WAF and hostname-isolated prod/UAT edge rate-limit rules."
  type        = bool
  default     = false
}
