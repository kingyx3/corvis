output "service_account_email" {
  description = "Narrow cost-guard identity used by the runtime and manual recovery workflow."
  value       = google_service_account.cost_guard.email
}

output "janitor_service_account_email" {
  description = "Narrow identity used by scheduled artifact/secret cost hygiene."
  value       = google_service_account.cost_janitor.email
}

output "service_name" {
  description = "Cloud Run cost-guard service name when a runtime image is selected."
  value       = local.runtime_enabled ? google_cloud_run_v2_service.cost_guard[0].name : null
}
