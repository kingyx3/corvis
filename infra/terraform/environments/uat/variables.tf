variable "project_id" { type = string }
variable "source_bucket_name" { type = string }

variable "api_image" {
  description = "Immutable UAT API image reference. Empty keeps the API runtime unprovisioned until image promotion is configured."
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
