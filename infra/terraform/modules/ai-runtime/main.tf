terraform {
  required_providers {
    google = { source = "hashicorp/google" }
  }
}

locals {
  ai_runtime_requested = trimspace(var.litellm_image) != "" || trimspace(var.extractor_image) != "" || trimspace(var.litellm_models_json) != ""
  ai_runtime_enabled   = trimspace(var.litellm_image) != "" && trimspace(var.extractor_image) != "" && trimspace(var.litellm_models_json) != ""
}

resource "terraform_data" "configuration_guard" {
  lifecycle {
    precondition {
      condition     = !local.ai_runtime_requested || local.ai_runtime_enabled
      error_message = "AI runtime activation requires immutable litellm_image, immutable extractor_image, and litellm_models_json together."
    }
    precondition {
      condition     = !local.ai_runtime_enabled || can(jsondecode(var.litellm_models_json))
      error_message = "litellm_models_json must be valid JSON when the AI runtime is enabled."
    }
  }
}

data "google_secret_manager_secret" "provider_credentials" {
  count     = local.ai_runtime_enabled ? 1 : 0
  project   = var.project_id
  secret_id = "corvis-ai-provider-credentials-${var.environment}"
}

data "google_secret_manager_secret" "litellm_master_key" {
  count     = local.ai_runtime_enabled ? 1 : 0
  project   = var.project_id
  secret_id = "corvis-litellm-master-key-${var.environment}"
}

data "google_secret_manager_secret" "atlassian_skill_read" {
  count     = local.ai_runtime_enabled ? 1 : 0
  project   = var.project_id
  secret_id = "corvis-atlassian-skill-read-${var.environment}"
}

resource "google_service_account" "litellm" {
  count        = local.ai_runtime_enabled ? 1 : 0
  project      = var.project_id
  account_id   = "corvis-litellm-${var.environment}"
  display_name = "Corvis LiteLLM ${var.environment}"
}

resource "google_service_account" "extractor" {
  count        = local.ai_runtime_enabled ? 1 : 0
  project      = var.project_id
  account_id   = "corvis-extractor-${var.environment}"
  display_name = "Corvis extractor ${var.environment}"
}

resource "google_secret_manager_secret_iam_member" "litellm_provider_credentials" {
  count     = local.ai_runtime_enabled ? 1 : 0
  project   = var.project_id
  secret_id = data.google_secret_manager_secret.provider_credentials[0].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.litellm[0].email}"
}

resource "google_secret_manager_secret_iam_member" "litellm_master_key" {
  count     = local.ai_runtime_enabled ? 1 : 0
  project   = var.project_id
  secret_id = data.google_secret_manager_secret.litellm_master_key[0].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.litellm[0].email}"
}

resource "google_secret_manager_secret_iam_member" "extractor_master_key" {
  count     = local.ai_runtime_enabled ? 1 : 0
  project   = var.project_id
  secret_id = data.google_secret_manager_secret.litellm_master_key[0].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.extractor[0].email}"
}

resource "google_secret_manager_secret_iam_member" "extractor_skill_read" {
  count     = local.ai_runtime_enabled ? 1 : 0
  project   = var.project_id
  secret_id = data.google_secret_manager_secret.atlassian_skill_read[0].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.extractor[0].email}"
}

resource "google_storage_bucket_iam_member" "extractor_viewer" {
  count  = local.ai_runtime_enabled ? 1 : 0
  bucket = var.source_bucket_name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.extractor[0].email}"
}

resource "google_storage_bucket_iam_member" "extractor_creator" {
  count  = local.ai_runtime_enabled ? 1 : 0
  bucket = var.source_bucket_name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.extractor[0].email}"
}

resource "google_cloud_run_v2_service" "litellm" {
  count    = local.ai_runtime_enabled ? 1 : 0
  project  = var.project_id
  name     = "corvis-litellm-${var.environment}"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  deletion_protection = var.environment == "prod" && !var.decommission_mode

  template {
    service_account                  = google_service_account.litellm[0].email
    timeout                          = "450s"
    max_instance_request_concurrency = 20

    scaling {
      min_instance_count = 0
      max_instance_count = var.environment == "prod" ? 10 : 3
    }

    containers {
      image = var.litellm_image

      ports { container_port = 4000 }

      startup_probe {
        timeout_seconds   = 5
        period_seconds    = 10
        failure_threshold = 18
        tcp_socket { port = 4000 }
      }

      liveness_probe {
        timeout_seconds   = 5
        period_seconds    = 30
        failure_threshold = 3
        tcp_socket { port = 4000 }
      }

      env { name = "PORT" value = "4000" }
      env { name = "CORVIS_LITELLM_MODELS_JSON" value = var.litellm_models_json }
      env {
        name = "CORVIS_AI_PROVIDER_CREDENTIALS_JSON"
        value_source {
          secret_key_ref {
            secret  = data.google_secret_manager_secret.provider_credentials[0].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "LITELLM_MASTER_KEY"
        value_source {
          secret_key_ref {
            secret  = data.google_secret_manager_secret.litellm_master_key[0].secret_id
            version = "latest"
          }
        }
      }

      resources {
        limits = { cpu = "1", memory = "1Gi" }
      }
    }
  }

  lifecycle {
    precondition {
      condition     = can(regex("@sha256:[0-9a-fA-F]{64}$", var.litellm_image))
      error_message = "litellm_image must be an immutable digest reference."
    }
  }

  depends_on = [
    terraform_data.configuration_guard,
    google_secret_manager_secret_iam_member.litellm_provider_credentials,
    google_secret_manager_secret_iam_member.litellm_master_key,
  ]
}

resource "google_cloud_run_v2_service" "extractor" {
  count    = local.ai_runtime_enabled ? 1 : 0
  project  = var.project_id
  name     = "corvis-extractor-${var.environment}"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  deletion_protection = var.environment == "prod" && !var.decommission_mode

  template {
    service_account                  = google_service_account.extractor[0].email
    timeout                          = "540s"
    max_instance_request_concurrency = 2

    scaling {
      min_instance_count = 0
      max_instance_count = var.environment == "prod" ? 10 : 3
    }

    containers {
      image = var.extractor_image

      ports { container_port = 8080 }

      startup_probe {
        timeout_seconds   = 5
        period_seconds    = 10
        failure_threshold = 12
        http_get { path = "/healthz" port = 8080 }
      }

      liveness_probe {
        timeout_seconds   = 5
        period_seconds    = 30
        failure_threshold = 3
        http_get { path = "/healthz" port = 8080 }
      }

      env { name = "PORT" value = "8080" }
      env { name = "CORVIS_OBJECT_STORE_BUCKET" value = var.source_bucket_name }
      env { name = "CORVIS_LITELLM_URL" value = google_cloud_run_v2_service.litellm[0].uri }
      env { name = "CORVIS_LITELLM_AUDIENCE" value = google_cloud_run_v2_service.litellm[0].uri }
      env { name = "CORVIS_LITELLM_MODELS_JSON" value = var.litellm_models_json }
      env { name = "CORVIS_EXTRACTION_MODEL" value = "corvis-extract-primary" }
      env { name = "CORVIS_EXTRACTION_VERIFIER_MODEL" value = "corvis-extract-verifier" }
      env {
        name = "LITELLM_MASTER_KEY"
        value_source {
          secret_key_ref {
            secret  = data.google_secret_manager_secret.litellm_master_key[0].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "CORVIS_ATLASSIAN_SKILL_READ_CREDENTIALS_JSON"
        value_source {
          secret_key_ref {
            secret  = data.google_secret_manager_secret.atlassian_skill_read[0].secret_id
            version = "latest"
          }
        }
      }

      resources {
        limits = { cpu = "1", memory = "1Gi" }
      }
    }
  }

  lifecycle {
    precondition {
      condition     = can(regex("@sha256:[0-9a-fA-F]{64}$", var.extractor_image))
      error_message = "extractor_image must be an immutable digest reference."
    }
  }

  depends_on = [
    terraform_data.configuration_guard,
    google_cloud_run_v2_service.litellm,
    google_secret_manager_secret_iam_member.extractor_master_key,
    google_secret_manager_secret_iam_member.extractor_skill_read,
    google_storage_bucket_iam_member.extractor_viewer,
    google_storage_bucket_iam_member.extractor_creator,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "extractor_invokes_litellm" {
  count    = local.ai_runtime_enabled ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.litellm[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.extractor[0].email}"
}

resource "google_cloud_run_v2_service_iam_member" "worker_invokes_extractor" {
  count    = local.ai_runtime_enabled ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.extractor[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${var.worker_service_account_email}"
}
