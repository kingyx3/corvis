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
  runtime_enabled = trimspace(var.control_loop_image) != ""
  schedules = {
    daily = {
      mode     = "daily"
      schedule = "17 2 * * *"
    }
    weekly = {
      mode     = "weekly"
      schedule = "23 3 * * 0"
    }
    monthly = {
      mode     = "monthly-candidate"
      schedule = "31 4 * * 0"
    }
  }
}

resource "terraform_data" "image_guard" {
  lifecycle {
    precondition {
      condition     = !local.runtime_enabled || can(regex("@sha256:[0-9a-fA-F]{64}$", var.control_loop_image))
      error_message = "control_loop_image must be an immutable digest reference ending in @sha256:<64 hex chars>."
    }
  }
}

resource "google_project_service_identity" "cloud_scheduler" {
  count    = local.runtime_enabled ? 1 : 0
  provider = google-beta
  project  = var.project_id
  service  = "cloudscheduler.googleapis.com"
}

resource "google_service_account_iam_member" "cloud_scheduler_token_creator" {
  count              = local.runtime_enabled ? 1 : 0
  service_account_id = "projects/${var.project_id}/serviceAccounts/${var.service_account_email}"
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_project_service_identity.cloud_scheduler[0].email}"
}

resource "google_cloud_run_v2_job" "control_loop" {
  for_each = local.runtime_enabled ? local.schedules : {}

  project  = var.project_id
  name     = "corvis-control-loop-${each.key}-${var.environment}"
  location = var.region

  deletion_protection = var.environment == "prod" && !var.decommission_mode

  template {
    labels = {
      service     = "corvis-control-loop"
      environment = var.environment
      schedule    = each.key
      managed_by  = "terraform"
    }

    template {
      service_account = var.service_account_email
      timeout         = "900s"
      max_retries     = 1

      containers {
        image = var.control_loop_image
        args  = ["--mode", each.value.mode]

        env {
          name  = "CORVIS_ENVIRONMENT"
          value = var.environment
        }
        env {
          name  = "CONTROL_LOOP_STATE_BUCKET"
          value = var.state_bucket_name
        }
        env {
          name  = "CONTROL_LOOP_STATE_PREFIX"
          value = "control-loop/${var.environment}"
        }
        env {
          name  = "GITHUB_REPOSITORY"
          value = "kingyx3/corvis"
        }
        env {
          name  = "GITHUB_REPOSITORY_OWNER"
          value = "kingyx3"
        }

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }
      }
    }
  }

  lifecycle {
    precondition {
      condition     = can(regex("@sha256:[0-9a-fA-F]{64}$", var.control_loop_image))
      error_message = "control_loop_image must remain pinned to an immutable digest."
    }
  }

  depends_on = [terraform_data.image_guard]
}

resource "google_cloud_run_v2_job_iam_member" "scheduler_invoker" {
  for_each = google_cloud_run_v2_job.control_loop

  project  = var.project_id
  location = var.region
  name     = each.value.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${var.service_account_email}"
}

resource "google_cloud_scheduler_job" "control_loop" {
  for_each = google_cloud_run_v2_job.control_loop

  project          = var.project_id
  region           = var.region
  name             = "corvis-control-loop-${each.key}-${var.environment}"
  description      = "Run the ${each.key} Corvis control-loop reconciliation job."
  schedule         = local.schedules[each.key].schedule
  time_zone        = "Asia/Singapore"
  attempt_deadline = "900s"

  retry_config {
    retry_count          = 1
    max_retry_duration   = "900s"
    min_backoff_duration = "30s"
    max_backoff_duration = "300s"
    max_doublings        = 2
  }

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${each.value.name}:run"
    body        = base64encode("{}")
    headers = {
      "Content-Type" = "application/json"
    }

    oauth_token {
      service_account_email = var.service_account_email
    }
  }

  depends_on = [
    google_cloud_run_v2_job_iam_member.scheduler_invoker,
    google_service_account_iam_member.cloud_scheduler_token_creator,
  ]
}
