variable "litellm_image" {
  description = "Immutable production LiteLLM image reference promoted from the accepted release set."
  type        = string
  default     = ""
}

variable "extractor_image" {
  description = "Immutable production governed extractor image reference promoted from the accepted release set."
  type        = string
  default     = ""
}

variable "litellm_models_json" {
  description = "Non-secret JSON mapping Corvis extraction aliases to provider/model identifiers."
  type        = string
  default     = ""
}
