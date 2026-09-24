variable "account_id" {
  description = "Cloudflare account ID derived from the selected zone."
  type        = string
}

variable "zone_id" {
  description = "Cloudflare zone ID for the shared Corvis domain."
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
  description = "Environment-specific public API hostname. Shared zone TLS/WAF/rate/cache policy is managed separately."
  type        = string

  validation {
    condition     = trimspace(var.api_hostname) != ""
    error_message = "api_hostname must be non-empty when the Cloudflare edge module is enabled."
  }
}
