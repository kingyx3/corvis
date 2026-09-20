variable "project_id" { type = string }
variable "source_bucket_name" { type = string }

variable "decommission_mode" {
  description = "Set only by the guarded environment decommission workflow."
  type        = bool
  default     = false
}
