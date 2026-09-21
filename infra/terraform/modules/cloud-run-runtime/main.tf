terraform {
  required_providers {
    google = {
      source = "hashicorp/google"
    }
    google-beta = {
      source = "hashicorp/google-beta"
    }
  }
}

locals {
  runtime_enabled                = trimspace(var.api_image) != ""
  worker_audience                = "https://corvis-worker-${var.environment}.internal"
  deployer_service_account_email = "corvis-deploy@${var.project_id}.iam.gserviceaccount.com"
  worker_service_account_name    = "projects/${var.project_id}/serviceAccounts/${var.worker_service_account_email}"
}

resource "terraform_data" "runtime_configuration_guard" {
  lifecycle {
    precondition {
      condition     = !local.runtime_enabled || (trimspace(var.auth_issuer) != "" && trimspace(var.auth_audience) != "")
      error_message = "A promoted runtime requires auth_issuer and auth_audience; production must never start without an identity-provider contract."
    }
  }
}

# Explicitly materialize the managed-service identities before granting them
# token-mint permissions. This avoids a first-apply race after an API has only
# just been enabled by the foundation module.
resource "google_project_service_identity" "pubsub" {
  count    = local.runtime_enabled ? 1 : 0
  provider = google-beta
  project  = var.project_id
  service  = "pubsub.googleapis.com"
}

resource "google_project_service_identity" "cloud_tasks" {
  count    = local.runtime_enabled ? 1 : 0
  provider = google-beta
  project  = var.project_id
  service  = "cloudtasks.googleapis.com"
}

resource "google_project_service_identity" "cloud_scheduler" {
  count    = local.runtime_enabled ? 1 : 0
  provider = google-beta
  project  = var.project_id
  service  = "cloudscheduler.googleapis.com"
}

resource "google_service_account_iam_member" "pubsub_token_creator" {
  count              = local.runtime_enabled ? 1 : 0
  service_account_id = local.worker_service_account_name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_project_service_identity.pubsub[0].email}"
}

resource "google_service_account_iam_member" "cloud_tasks_token_creator" {
  count              = local.runtime_enabled ? 1 : 0
  service_account_id = local.worker_service_account_name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_project_service_identity.cloud_tasks[0].email}"
}

resource "google_service_account_iam_member" "cloud_scheduler_token_creator" {
  count              = local.runtime_enabled ? 1 : 0
  service_account_id = local.worker_service_account_name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_project_service_identity.cloud_scheduler[0].email}"
}

resource "google_secret_manager_secret" "postgres_dsn" {
  project   = var.project_id
  secret_id = "${var.postgres_dsn_secret_id}-${var.environment}"

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
}

resource "google_secret_manager_secret_iam_member" "api_postgres" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.postgres_dsn.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.api_service_account_email}"
}

resource "google_secret_manager_secret_iam_member" "worker_postgres" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.postgres_dsn.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.worker_service_account_email}"
}

resource "google_secret_manager_secret_iam_member" "deployer_postgres" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.postgres_dsn.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.deployer_service_account_email}"
}

resource "google_cloud_run_v2_service" "worker" {
  count    = local.runtime_enabled ? 1 : 0
  project  = var.project_id
  name     = "corvis-worker-${var.environment}"
  location = var.region

  # Pub/Sub push, Cloud Tasks and Cloud Scheduler call the default service URL
  # with Google-signed OIDC. Network reachability is therefore permitted while
  # Cloud Run IAM remains the invocation boundary; no allUsers grant exists.
  ingress          = "INGRESS_TRAFFIC_ALL"
  custom_audiences = [local.worker_audience]

  deletion_protection = var.environment == "prod" && !var.decommission_mode

  template {
    service_account = var.worker_service_account_email

    scaling {
      min_instance_count = 0
      max_instance_count = var.environment == "prod" ? 20 : 5
    }

    containers {
      image = var.api_image

      ports {
        container_port = 3000
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "CORVIS_ENVIRONMENT"
        value = var.environment
      }
      env {
        name  = "CORVIS_AUTH_ISSUER"
        value = var.auth_issuer
      }
      env {
        name  = "CORVIS_AUTH_AUDIENCE"
        value = var.auth_audience
      }
      env {
        name  = "CORVIS_AUTH_JWKS_URL"
        value = var.auth_jwks_url
      }
      env {
        name  = "CORVIS_OBJECT_STORE_BUCKET"
        value = var.source_bucket_name
      }
      env {
        name  = "CORVIS_UPLOAD_ALLOWED_ORIGINS"
        value = join(",", var.upload_allowed_origins)
      }
      env {
        name  = "CORVIS_GCP_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "CORVIS_GCP_REGION"
        value = var.region
      }
      env {
        name  = "CORVIS_PROCESSING_TOPIC_NAME"
        value = var.processing_topic_name
      }
      env {
        name  = "CORVIS_PROCESSING_QUEUE_NAME"
        value = var.processing_queue_name
      }
      env {
        name  = "CORVIS_PROCESSING_WORKER_AUDIENCE"
        value = local.worker_audience
      }
      env {
        name  = "CORVIS_PROCESSING_WORKER_SERVICE_ACCOUNT"
        value = var.worker_service_account_email
      }

      env {
        name = "CORVIS_POSTGRES_DSN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.postgres_dsn.secret_id
            version = "latest"
          }
        }
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
    }
  }

  lifecycle {
    precondition {
      condition     = can(regex("@sha256:[0-9a-fA-F]{64}$", var.api_image))
      error_message = "api_image must be an immutable digest reference ending in @sha256:<64 hex chars>."
    }
  }

  depends_on = [
    terraform_data.runtime_configuration_guard,
    google_secret_manager_secret_iam_member.worker_postgres,
    google_service_account_iam_member.pubsub_token_creator,
    google_service_account_iam_member.cloud_tasks_token_creator,
    google_service_account_iam_member.cloud_scheduler_token_creator,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "worker_invoker" {
  count = local.runtime_enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.worker[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${var.worker_service_account_email}"
}

resource "google_pubsub_subscription" "processing_worker" {
  count = local.runtime_enabled ? 1 : 0

  project              = var.project_id
  name                 = "processing-worker-${var.environment}"
  topic                = "projects/${var.project_id}/topics/${var.processing_topic_name}"
  ack_deadline_seconds = 600

  push_config {
    push_endpoint = "${google_cloud_run_v2_service.worker[0].uri}/api/internal/processing-stage"

    oidc_token {
      service_account_email = var.worker_service_account_email
      audience              = local.worker_audience
    }
  }

  retry_policy {
    minimum_backoff = "5s"
    maximum_backoff = "300s"
  }

  dead_letter_policy {
    dead_letter_topic     = "projects/${var.project_id}/topics/${var.processing_dead_letter_topic_name}"
    max_delivery_attempts = 8
  }

  depends_on = [google_cloud_run_v2_service_iam_member.worker_invoker]
}

resource "google_pubsub_topic_iam_member" "dead_letter_publisher" {
  count = local.runtime_enabled ? 1 : 0

  project = var.project_id
  topic   = var.processing_dead_letter_topic_name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_project_service_identity.pubsub[0].email}"
}

resource "google_pubsub_subscription_iam_member" "dead_letter_subscriber" {
  count = local.runtime_enabled ? 1 : 0

  project      = var.project_id
  subscription = google_pubsub_subscription.processing_worker[0].name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_project_service_identity.pubsub[0].email}"
}

resource "google_cloud_scheduler_job" "delivery" {
  count = local.runtime_enabled ? 1 : 0

  project          = var.project_id
  region           = var.region
  name             = "corvis-delivery-${var.environment}"
  description      = "Drain durable export/webhook/processing outboxes through the private Corvis worker."
  schedule         = "* * * * *"
  time_zone        = "Etc/UTC"
  attempt_deadline = "300s"

  retry_config {
    retry_count          = 3
    max_retry_duration   = "300s"
    min_backoff_duration = "5s"
    max_backoff_duration = "60s"
    max_doublings        = 3
  }

  http_target {
    http_method = "POST"
    uri         = "${google_cloud_run_v2_service.worker[0].uri}/api/internal/delivery"
    body        = base64encode("{}")
    headers = {
      "Content-Type" = "application/json"
    }

    oidc_token {
      service_account_email = var.worker_service_account_email
      audience              = local.worker_audience
    }
  }

  depends_on = [google_cloud_run_v2_service_iam_member.worker_invoker]
}

resource "google_cloud_run_v2_service" "api" {
  count    = local.runtime_enabled ? 1 : 0
  project  = var.project_id
  name     = "corvis-api-${var.environment}"
  location = var.region

  # API Gateway is not a Cloud Run internal-ingress source. The network endpoint
  # therefore remains reachable, while IAM is the invocation boundary: no
  # allUsers grant exists and only the dedicated gateway service account receives
  # roles/run.invoker in the gcp-api-gateway module.
  ingress = "INGRESS_TRAFFIC_ALL"

  deletion_protection = var.environment == "prod" && !var.decommission_mode

  template {
    service_account = var.api_service_account_email

    scaling {
      min_instance_count = 0
      max_instance_count = var.environment == "prod" ? 20 : 5
    }

    containers {
      image = var.api_image

      ports {
        container_port = 3000
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "CORVIS_ENVIRONMENT"
        value = var.environment
      }
      env {
        name  = "CORVIS_AUTH_ISSUER"
        value = var.auth_issuer
      }
      env {
        name  = "CORVIS_AUTH_AUDIENCE"
        value = var.auth_audience
      }
      env {
        name  = "CORVIS_AUTH_JWKS_URL"
        value = var.auth_jwks_url
      }
      env {
        name  = "CORVIS_OBJECT_STORE_BUCKET"
        value = var.source_bucket_name
      }
      env {
        name  = "CORVIS_UPLOAD_ALLOWED_ORIGINS"
        value = join(",", var.upload_allowed_origins)
      }
      env {
        name  = "CORVIS_GCP_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "CORVIS_GCP_REGION"
        value = var.region
      }
      env {
        name  = "CORVIS_PROCESSING_TOPIC_NAME"
        value = var.processing_topic_name
      }
      env {
        name  = "CORVIS_PROCESSING_QUEUE_NAME"
        value = var.processing_queue_name
      }
      env {
        name  = "CORVIS_PROCESSING_WORKER_URL"
        value = "${google_cloud_run_v2_service.worker[0].uri}/api/internal/processing-stage"
      }
      env {
        name  = "CORVIS_PROCESSING_WORKER_AUDIENCE"
        value = local.worker_audience
      }
      env {
        name  = "CORVIS_PROCESSING_WORKER_SERVICE_ACCOUNT"
        value = var.worker_service_account_email
      }

      env {
        name = "CORVIS_POSTGRES_DSN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.postgres_dsn.secret_id
            version = "latest"
          }
        }
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
    }
  }

  lifecycle {
    precondition {
      condition     = can(regex("@sha256:[0-9a-fA-F]{64}$", var.api_image))
      error_message = "api_image must be an immutable digest reference ending in @sha256:<64 hex chars>."
    }
  }

  depends_on = [
    terraform_data.runtime_configuration_guard,
    google_secret_manager_secret_iam_member.api_postgres,
    google_cloud_run_v2_service_iam_member.worker_invoker,
  ]
}
