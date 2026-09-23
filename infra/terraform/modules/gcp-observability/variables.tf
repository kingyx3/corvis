variable "project_id" {
  type = string
}

variable "environment" {
  type = string

  validation {
    condition     = contains(["dev", "uat", "prod"], var.environment)
    error_message = "environment must be dev, uat, or prod"
  }
}

variable "api_service_name" {
  description = "Cloud Run API service name to monitor. Empty disables the API alert policy (for example before #62 activates the runtime)."
  type        = string
  default     = ""
}

variable "dead_letter_subscription_name" {
  description = "Pub/Sub dead-letter pull subscription short name (gcp-foundation's dead_letter_subscription_name output). Empty disables the alert policy."
  type        = string
  default     = ""
}

variable "processing_queue_name" {
  description = "Cloud Tasks queue short name (gcp-foundation's processing_queue_name output). Empty disables the alert policy."
  type        = string
  default     = ""
}

variable "notification_channel_ids" {
  description = "Existing Cloud Monitoring notification channel IDs. Channel creation itself is one-time external bootstrap (docs/GITHUB_ENVIRONMENTS.md), not managed here."
  type        = list(string)
  default     = []
}

variable "billing_account_id" {
  description = "Billing account to attach a budget to. Empty disables budget creation."
  type        = string
  default     = ""
  sensitive   = true
}

variable "monthly_budget_amount_usd" {
  type    = number
  default = 1000
}

variable "labels" {
  type    = map(string)
  default = {}
}
