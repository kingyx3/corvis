variable "project_id" {
  type = string
}

variable "environment" {
  type = string

  validation {
    condition     = contains(["uat", "prod"], var.environment)
    error_message = "gcp-cost-guard is only supported for production-like uat/prod environments"
  }
}

variable "region" {
  type    = string
  default = "asia-southeast1"
}

variable "api_image" {
  description = "Immutable Corvis API image used by the tiny IAM-private cost-guard service. Empty keeps only the budget topic provisioned during foundation bootstrap."
  type        = string
  default     = ""
}

variable "monthly_budget_amount_usd" {
  description = "Expected monthly budget amount, exposed to the service only for operator-visible configuration consistency."
  type        = number
}

variable "guard_threshold" {
  description = "Spend/budget ratio at which automated UAT consumption is paused."
  type        = number
  default     = 0.85

  validation {
    condition     = var.guard_threshold > 0 && var.guard_threshold <= 1
    error_message = "guard_threshold must be greater than 0 and at most 1"
  }
}

variable "decommission_mode" {
  description = "Set only by the guarded environment decommission workflow."
  type        = bool
  default     = false
}
