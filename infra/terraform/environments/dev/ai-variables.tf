variable "litellm_image" {
  description = "Immutable development LiteLLM image reference."
  type        = string
  default     = ""
}

variable "extractor_image" {
  description = "Immutable development governed extractor image reference."
  type        = string
  default     = ""
}

variable "litellm_models_json" {
  description = "Non-secret JSON mapping Corvis extraction aliases to provider/model identifiers."
  type        = string
  default     = ""
}
