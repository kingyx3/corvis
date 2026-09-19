output "api_service_name" {
  value = try(google_cloud_run_v2_service.api[0].name, null)
}

output "api_service_uri" {
  value     = try(google_cloud_run_v2_service.api[0].uri, null)
  sensitive = true
}

output "postgres_dsn_secret_id" {
  value = google_secret_manager_secret.postgres_dsn.secret_id
}

output "gateway_identity_secret_id" {
  value = google_secret_manager_secret.gateway_identity.secret_id
}
