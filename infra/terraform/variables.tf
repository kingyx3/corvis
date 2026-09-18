variable "aws_region" {
  description = "AWS region for the Corvis source-object store."
  type        = string
}

variable "environment" {
  description = "Environment name, e.g. staging or production."
  type        = string
  validation {
    condition     = contains(["development", "staging", "production"], var.environment)
    error_message = "environment must be development, staging, or production."
  }
}

variable "document_bucket_name" {
  description = "Globally unique private bucket for Corvis source documents and exports."
  type        = string
}

variable "allowed_web_origins" {
  description = "Exact HTTPS web application origins permitted to perform presigned multipart PUTs."
  type        = list(string)
  validation {
    condition     = length(var.allowed_web_origins) > 0 && alltrue([for origin in var.allowed_web_origins : startswith(origin, "https://") || startswith(origin, "http://localhost")])
    error_message = "Use exact HTTPS origins; localhost is allowed for development only."
  }
}

variable "default_object_lock_days" {
  description = "Short governance retention protecting new source versions from accidental deletion while contractual retention remains application-governed."
  type        = number
  default     = 7
  validation {
    condition     = var.default_object_lock_days >= 1 && var.default_object_lock_days <= 30
    error_message = "Default Object Lock should remain a short 1-30 day safety window; legal/customer retention is managed separately."
  }
}

variable "export_retention_days" {
  description = "Object-store retention for generated customer export files."
  type        = number
  default     = 7
}

variable "tags" {
  description = "Additional organization tags."
  type        = map(string)
  default     = {}
}
