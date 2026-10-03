module "ai_runtime" {
  source                       = "../../modules/ai-runtime"
  project_id                   = var.project_id
  environment                  = "prod"
  source_bucket_name           = module.foundation.source_bucket
  worker_service_account_email = module.foundation.worker_service_account
  litellm_image                = var.litellm_image
  extractor_image              = var.extractor_image
  litellm_models_json          = var.litellm_models_json
  decommission_mode            = var.decommission_mode

  depends_on = [module.api_runtime]
}

output "corvis_extraction_endpoint" {
  description = "Private governed extraction endpoint to set as CORVIS_EXTRACTION_ENDPOINT after first AI-runtime apply."
  value       = module.ai_runtime.extractor_service_uri
  sensitive   = true
}

output "corvis_extraction_audience" {
  description = "Google OIDC audience for the governed extractor; identical to the private Cloud Run endpoint."
  value       = module.ai_runtime.extractor_service_uri
  sensitive   = true
}
