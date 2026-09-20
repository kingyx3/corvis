output "gateway_hostname" {
  description = "Default gateway.dev hostname used only as the Cloudflare Worker upstream."
  value       = google_api_gateway_gateway.api.default_hostname
}

output "gateway_service_account_email" {
  description = "Only workload identity granted Cloud Run invoker on the Corvis API runtime."
  value       = google_service_account.gateway.email
}

output "edge_api_key" {
  description = "Gateway API key bound to the Cloudflare Worker as an encrypted secret."
  value       = google_apikeys_key.cloudflare_edge.key_string
  sensitive   = true
}

output "managed_service" {
  value = google_api_gateway_api.api.managed_service
}
