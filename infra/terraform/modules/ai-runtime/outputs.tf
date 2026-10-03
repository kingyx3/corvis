output "enabled" {
  value = local.ai_runtime_enabled
}

output "litellm_service_uri" {
  value     = local.ai_runtime_enabled ? google_cloud_run_v2_service.litellm[0].uri : ""
  sensitive = true
}

output "extractor_service_uri" {
  value     = local.ai_runtime_enabled ? google_cloud_run_v2_service.extractor[0].uri : ""
  sensitive = true
}

output "extractor_service_account" {
  value = local.ai_runtime_enabled ? google_service_account.extractor[0].email : ""
}
