output "service_name" { value = try(google_cloud_run_v2_service.customer[0].name, null) }
output "service_uri" {
  value     = try(google_cloud_run_v2_service.customer[0].uri, null)
  sensitive = true
}
output "service_account" { value = google_service_account.customer.email }
