output "control_loop_service_account" {
  value = google_service_account.control_loop.email
}

output "control_loop_state_bucket" {
  value = google_storage_bucket.control_loop_state.name
}
