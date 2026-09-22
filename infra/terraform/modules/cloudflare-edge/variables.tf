variable "account_id" {
  description = "Cloudflare account ID derived from the selected zone."
  type        = string
}

variable "zone_id" {
  description = "Cloudflare zone ID for the Corvis domain."
  type        = string
}

variable "gateway_hostname" {
  description = "Google API Gateway default hostname used only by the Cloudflare Worker."
  type        = string
}

variable "gateway_api_key" {
  description = "API key restricted to the Corvis managed API and injected only by the Cloudflare Worker."
  type        = string
  sensitive   = true
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
  description = "Desired per-IP API request ceiling. Terraform converts it to Cloudflare Free's supported 10-second rate-limit window."
  type        = number
  default     = 300

  validation {
    condition     = var.api_requests_per_minute >= 30
    error_message = "api_requests_per_minute must be at least 30."
  }
}

variable "enable_managed_waf" {
  description = "Deploy Cloudflare Managed and OWASP managed rulesets on Pro or a higher plan. Keep false on Free, which retains the baseline custom WAF plus Cloudflare Free Managed Ruleset."
  type        = bool
  default     = false
}
