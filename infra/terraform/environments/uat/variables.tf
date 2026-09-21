variable "project_id" { type = string }
variable "source_bucket_name" { type = string }

variable "api_image" {
  description = "Immutable UAT application image reference. Empty keeps API/worker runtimes unprovisioned until image promotion is configured."
  type        = string
  default     = ""
}

variable "control_loop_image" {
  description = "Immutable UAT control-loop image reference. Empty keeps scheduled control-loop jobs unprovisioned."
  type        = string
  default     = ""
}

variable "auth_issuer" {
  description = "Production-like OIDC issuer URL for this environment."
  type        = string
  default     = ""
}

variable "auth_audience" {
  description = "OIDC audience/client identifier for Corvis."
  type        = string
  default     = "corvis"
}

variable "auth_jwks_url" {
  description = "Optional explicit HTTPS JWKS URL; standard OIDC discovery is preferred."
  type        = string
  default     = ""
}

variable "cloudflare_zone_name" {
  description = "Cloudflare zone name. The provider resolves the zone ID at plan/apply time."
  type        = string
  default     = ""
}

variable "enable_cloudflare_managed_waf" {
  description = "Explicit rollout control for plan-dependent Cloudflare managed/OWASP rulesets."
  type        = bool
  default     = false
}

variable "monitoring_notification_channel_ids" {
  description = "Existing Cloud Monitoring notification channel IDs to attach to SLO alerts and the budget."
  type        = list(string)
  default     = []
}

variable "billing_account_id" {
  description = "Billing account for the monthly budget. Empty disables budget creation."
  type        = string
  default     = ""
  sensitive   = true
}

variable "monthly_budget_amount_usd" {
  type    = number
  default = 500
}

variable "decommission_mode" {
  description = "Set only by the guarded environment decommission workflow."
  type        = bool
  default     = false
}
