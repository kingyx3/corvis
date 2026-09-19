locals {
  labels = merge(
    {
      service     = "corvis"
      environment = var.environment
      managed_by  = "terraform"
    },
    var.labels,
  )

  required_services = toset([
    "artifactregistry.googleapis.com",
    "certificatemanager.googleapis.com",
    "cloudkms.googleapis.com",
    "cloudtasks.googleapis.com",
    "compute.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "networksecurity.googleapis.com",
    "pubsub.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "storage.googleapis.com",
  ])
}

resource "google_project_service" "required" {
  for_each           = local.required_services
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_project_organization_policy" "disable_service_account_key_creation" {
  count      = var.enforce_service_account_key_creation_disabled ? 1 : 0
  project    = var.project_id
  constraint = "iam.disableServiceAccountKeyCreation"

  boolean_policy {
    enforced = true
  }
}

resource "google_project_organization_policy" "disable_service_account_key_upload" {
  count      = var.enforce_service_account_key_upload_disabled ? 1 : 0
  project    = var.project_id
  constraint = "iam.disableServiceAccountKeyUpload"

  boolean_policy {
    enforced = true
  }
}

resource "google_kms_key_ring" "corvis" {
  project    = var.project_id
  name       = "corvis-${var.environment}"
  location   = var.region
  depends_on = [google_project_service.required]
}

resource "google_kms_crypto_key" "source" {
  name            = "source-artifacts"
  key_ring        = google_kms_key_ring.corvis.id
  rotation_period = "7776000s"

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_storage_bucket" "source" {
  project                     = var.project_id
  name                        = var.source_bucket_name
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = local.labels

  versioning {
    enabled = true
  }

  encryption {
    default_kms_key_name = google_kms_crypto_key.source.id
  }

  lifecycle_rule {
    condition {
      age            = 7
      matches_prefix = ["uploads/abandoned/", "quarantine/"]
    }

    action {
      type = "Delete"
    }
  }

  lifecycle_rule {
    condition {
      age            = 30
      matches_prefix = ["intermediate/", "exports/"]
    }

    action {
      type = "Delete"
    }
  }
}

resource "google_artifact_registry_repository" "containers" {
  project       = var.project_id
  location      = var.region
  repository_id = var.artifact_registry_repository
  format        = "DOCKER"
  labels        = local.labels
  depends_on    = [google_project_service.required]

  cleanup_policies {
    id     = "delete-untagged"
    action = "DELETE"

    condition {
      tag_state  = "UNTAGGED"
      older_than = "604800s"
    }
  }

  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"

    most_recent_versions {
      keep_count = 10
    }
  }
}

resource "google_pubsub_topic" "document_registered" {
  project    = var.project_id
  name       = "document-registered-${var.environment}"
  labels     = local.labels
  depends_on = [google_project_service.required]
}

resource "google_pubsub_topic" "processing_dead_letter" {
  project    = var.project_id
  name       = "processing-dead-letter-${var.environment}"
  labels     = local.labels
  depends_on = [google_project_service.required]
}

resource "google_cloud_tasks_queue" "processing" {
  project  = var.project_id
  name     = "processing-${var.environment}"
  location = var.region

  retry_config {
    max_attempts       = 8
    max_retry_duration = "3600s"
    min_backoff        = "5s"
    max_backoff        = "300s"
    max_doublings      = 5
  }

  depends_on = [google_project_service.required]
}

resource "google_service_account" "api" {
  project      = var.project_id
  account_id   = "corvis-api-${var.environment}"
  display_name = "Corvis API ${var.environment}"
  description  = "Keyless runtime identity for the Corvis API. Human/user-managed keys are prohibited in production."
}

resource "google_service_account" "worker" {
  project      = var.project_id
  account_id   = "corvis-worker-${var.environment}"
  display_name = "Corvis worker ${var.environment}"
  description  = "Keyless runtime identity for Corvis background processing. Human/user-managed keys are prohibited in production."
}

resource "google_project_iam_member" "api_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.api.email}"
}

resource "google_project_iam_member" "worker_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.worker.email}"
}

resource "google_storage_bucket_iam_member" "api_source_writer" {
  bucket = google_storage_bucket.source.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.api.email}"

  condition {
    title       = "api_upload_prefix_only"
    description = "The API may create objects only in the controlled uploads prefix."
    expression  = "resource.name.startsWith('projects/_/buckets/${google_storage_bucket.source.name}/objects/uploads/')"
  }
}

resource "google_storage_bucket_iam_member" "worker_source_reader" {
  bucket = google_storage_bucket.source.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.worker.email}"
}
