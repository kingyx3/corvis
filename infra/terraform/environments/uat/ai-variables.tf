variable "litellm_image" {
  description = "Immutable UAT LiteLLM image reference resolved from the Corvis release set."
  type        = string
  default     = ""
}

variable "extractor_image" {
  description = "Immutable UAT governed extractor image reference resolved from the Corvis release set."
  type        = string
  default     = ""
}

variable "litellm_models_json" {
  description = "Non-secret JSON mapping Corvis extraction aliases to provider/model identifiers."
  type        = string
  default     = ""
}
