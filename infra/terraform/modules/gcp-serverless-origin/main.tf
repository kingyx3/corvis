resource "google_compute_global_address" "api" {
  project      = var.project_id
  name         = "corvis-api-origin-${var.environment}"
  address_type = "EXTERNAL"
  ip_version   = "IPV4"
}

resource "google_compute_region_network_endpoint_group" "api" {
  project               = var.project_id
  name                  = "corvis-api-${var.environment}"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = var.cloud_run_service_name
  }
}

resource "google_compute_backend_service" "api" {
  project               = var.project_id
  name                  = "corvis-api-${var.environment}"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTP"
  timeout_sec           = 30
  enable_cdn            = false

  backend {
    group = google_compute_region_network_endpoint_group.api.id
  }
}

resource "google_compute_url_map" "api" {
  project         = var.project_id
  name            = "corvis-api-${var.environment}"
  default_service = google_compute_backend_service.api.id
}

resource "google_compute_url_map" "http_redirect" {
  project = var.project_id
  name    = "corvis-api-http-redirect-${var.environment}"

  default_url_redirect {
    https_redirect = true
    strip_query    = false
  }
}

resource "google_certificate_manager_certificate" "api" {
  project  = var.project_id
  name     = "corvis-api-${var.environment}"
  location = "global"

  managed {
    domains            = [var.hostname]
    dns_authorizations = [var.dns_authorization_id]
  }
}

resource "google_certificate_manager_certificate_map" "api" {
  project     = var.project_id
  name        = "corvis-api-${var.environment}"
  description = "Certificate map for the Corvis ${var.environment} API origin."
}

resource "google_certificate_manager_certificate_map_entry" "api" {
  project      = var.project_id
  name         = "corvis-api-${var.environment}"
  map          = google_certificate_manager_certificate_map.api.name
  hostname     = var.hostname
  certificates = [google_certificate_manager_certificate.api.id]
}

resource "google_compute_ssl_policy" "api" {
  project         = var.project_id
  name            = "corvis-api-${var.environment}"
  profile         = "MODERN"
  min_tls_version = "TLS_1_2"
}

resource "google_compute_target_https_proxy" "api" {
  project         = var.project_id
  name            = "corvis-api-${var.environment}"
  url_map         = google_compute_url_map.api.id
  certificate_map = "//certificatemanager.googleapis.com/${google_certificate_manager_certificate_map.api.id}"
  ssl_policy      = google_compute_ssl_policy.api.id

  depends_on = [google_certificate_manager_certificate_map_entry.api]
}

resource "google_compute_target_http_proxy" "redirect" {
  project = var.project_id
  name    = "corvis-api-http-redirect-${var.environment}"
  url_map = google_compute_url_map.http_redirect.id
}

resource "google_compute_global_forwarding_rule" "https" {
  project               = var.project_id
  name                  = "corvis-api-https-${var.environment}"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_protocol           = "TCP"
  port_range            = "443"
  network_tier          = "PREMIUM"
  ip_address            = google_compute_global_address.api.address
  target                = google_compute_target_https_proxy.api.id
}

resource "google_compute_global_forwarding_rule" "http" {
  project               = var.project_id
  name                  = "corvis-api-http-${var.environment}"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_protocol           = "TCP"
  port_range            = "80"
  network_tier          = "PREMIUM"
  ip_address            = google_compute_global_address.api.address
  target                = google_compute_target_http_proxy.redirect.id
}

resource "google_cloud_run_v2_service_iam_member" "load_balancer_invoker" {
  project  = var.project_id
  location = var.region
  name     = var.cloud_run_service_name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
