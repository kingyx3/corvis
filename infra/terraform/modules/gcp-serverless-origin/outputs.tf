output "ipv4_address" {
  description = "Derived global IPv4 address for the public API origin."
  value       = google_compute_global_address.api.address
}

output "https_forwarding_rule" {
  value = google_compute_global_forwarding_rule.https.name
}

output "serverless_neg" {
  value = google_compute_region_network_endpoint_group.api.name
}
