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
    "apigateway.googleapis.com",
    "apikeys.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudkms.googleapis.com",
    "cloudscheduler.googleapis.com",
    "cloudtasks.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "pubsub.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "servicecontrol.googleapis.com",
    "servicemanagement.googleapis.com",
    "serviceusage.googleapis.com",
    "storage.googleapis.com",
  ])

  deployer_service_account_email = "corvis-deploy@${var.project_id}.iam.gserviceaccount.com"
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

# CMEK on the source bucket is used by the Cloud Storage service agent, not by
# the deployer or runtime identities. Grant it exactly the key it must use,
# before the bucket (and its default_kms_key_name) is created.
data "google_storage_project_service_account" "gcs" {
  project    = var.project_id
  depends_on = [google_project_service.required]
}

resource "google_kms_crypto_key_iam_member" "source_gcs_service_agent" {
  crypto_key_id = google_kms_crypto_key.source.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${data.google_storage_project_service_account.gcs.email_address}"
}

resource "google_storage_bucket" "source" {
  project                     = var.project_id
  name                        = var.source_bucket_name
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = var.decommission_mode
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

  # Versioning turns a lifecycle Delete of a live object into a noncurrent
  # version. Expire those noncurrent versions for the same lifecycle-managed
  # prefixes so transient/export storage does not grow without bound.
  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 7
      matches_prefix             = ["uploads/abandoned/", "quarantine/", "intermediate/", "exports/"]
    }

    action {
      type = "Delete"
    }
  }

  depends_on = [google_kms_crypto_key_iam_member.source_gcs_service_agent]
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

# Pub/Sub drops messages published to a topic with no subscription. Retain
# dead-lettered processing messages on a durable pull subscription so they can be
# inspected/replayed and so the backlog is observable as a subscription metric.
resource "google_pubsub_subscription" "processing_dead_letter" {
  project                    = var.project_id
  name                       = "processing-dead-letter-${var.environment}"
  topic                      = google_pubsub_topic.processing_dead_letter.id
  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"
  labels                     = local.labels

  expiration_policy {
    ttl = ""
  }
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

# The API owns upload-session state and quarantine lifecycle in this bucket. Its
# GCS adapter creates, reads/lists and deletes object-level records, so Creator
# is insufficient; Object User is the narrow predefined object CRUD role and
# does not grant bucket administration.
resource "google_storage_bucket_iam_member" "api_source_objects" {
  bucket = google_storage_bucket.source.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.api.email}"
}

resource "google_storage_bucket_iam_member" "worker_source_reader" {
  bucket = google_storage_bucket.source.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.worker.email}"
}

# The API owns the durable outbox dispatch loop. Give it only the two transport
# permissions required to move processing work into the managed topic/queue.
resource "google_pubsub_topic_iam_member" "api_processing_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.document_registered.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.api.email}"
}

resource "google_cloud_tasks_queue_iam_member" "api_processing_enqueuer" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_tasks_queue.processing.name
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${google_service_account.api.email}"
}

# Creating an authenticated Cloud Task requires the caller to be allowed to act
# as the target worker identity. Terraform itself needs the same narrow grant to
# configure provider-side authenticated push/scheduler bindings.
resource "google_service_account_iam_member" "api_act_as_worker" {
  service_account_id = google_service_account.worker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.api.email}"
}

# Cloud Scheduler invokes /api/internal/delivery on the worker, which drains the
# same processing outbox as the worker identity: it publishes to the processing
# topic and creates OIDC Cloud Tasks that run as the worker itself.
resource "google_pubsub_topic_iam_member" "worker_processing_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.document_registered.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.worker.email}"
}

resource "google_cloud_tasks_queue_iam_member" "worker_processing_enqueuer" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_tasks_queue.processing.name
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${google_service_account.worker.email}"
}

resource "google_service_account_iam_member" "worker_act_as_worker" {
  service_account_id = google_service_account.worker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.worker.email}"
}

# Deploying a Cloud Run service that runs as a service account requires the
# deployer to act as that identity; keep each grant resource-scoped.
resource "google_service_account_iam_member" "deployer_act_as_api" {
  service_account_id = google_service_account.api.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${local.deployer_service_account_email}"
}

resource "google_service_account_iam_member" "deployer_act_as_worker" {
  service_account_id = google_service_account.worker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${local.deployer_service_account_email}"
}
