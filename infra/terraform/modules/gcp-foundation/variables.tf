variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "asia-southeast1"
}

variable "environment" {
  type = string

  validation {
    condition     = contains(["dev", "uat", "prod"], var.environment)
    error_message = "environment must be dev, uat, or prod"
  }
}

variable "source_bucket_name" {
  type = string
}

variable "artifact_registry_repository" {
  type    = string
  default = "corvis"
}

variable "labels" {
  type    = map(string)
  default = {}
}
