output "gateway_hostname" {
  value = google_api_gateway_gateway.web.default_hostname
}

output "edge_api_key" {
  value     = google_apikeys_key.cloudflare_edge.key_string
  sensitive = true
}
