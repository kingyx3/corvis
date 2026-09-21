output "api_service_name" {
  value = try(google_cloud_run_v2_service.api[0].name, null)
}

output "api_service_uri" {
  value     = try(google_cloud_run_v2_service.api[0].uri, null)
  sensitive = true
}

output "worker_service_name" {
  value = try(google_cloud_run_v2_service.worker[0].name, null)
}

output "worker_service_uri" {
  value     = try(google_cloud_run_v2_service.worker[0].uri, null)
  sensitive = true
}

output "worker_audience" {
  value = local.worker_audience
}

output "postgres_dsn_secret_id" {
  value = google_secret_manager_secret.postgres_dsn.secret_id
}
