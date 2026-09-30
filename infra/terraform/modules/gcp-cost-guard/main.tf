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
  service_name                   = "corvis-cost-guard-${var.environment}"
  service_account_id             = "corvis-cost-guard-${var.environment}"
  service_account_email          = "${local.service_account_id}@${var.project_id}.iam.gserviceaccount.com"
  audience                       = "https://${local.service_name}.internal"
  budget_display_name            = "corvis-${var.environment}-monthly-budget"
  budget_topic_name              = "corvis-budget-updates-${var.environment}"
  deployer_service_account_email = "corvis-deploy@${var.project_id}.iam.gserviceaccount.com"
}

# This topic exists even before a runtime image is selected so the Billing
# Budget resource can be connected during the foundation bootstrap. Until the
# first runtime promotion there is intentionally no push subscription: the
# foundation has no scheduled application consumption to pause yet.
resource "google_pubsub_topic" "budget_updates" {
  project = var.project_id
  name    = local.budget_topic_name

  labels = {
    service     = "corvis-cost-guard"
    environment = var.environment
    managed_by  = "terraform"
  }
}

resource "google_service_account" "cost_guard" {
  project      = var.project_id
  account_id   = local.service_account_id
  display_name = "Corvis cost guard ${var.environment}"
  description  = "Keyless identity that may pause/resume only Corvis Scheduler jobs and the processing queue for non-destructive cost hibernation."
}

# A purpose-built role avoids broad Scheduler/Cloud Tasks administration. Resume
# is included so the guarded GitHub recovery workflow can restore UAT through
# this same identity; the runtime endpoint itself only invokes pause operations.
resource "google_project_iam_custom_role" "cost_guard" {
  project     = var.project_id
  role_id     = "corvisCostGuard_${var.environment}"
  title       = "Corvis cost guard ${var.environment}"
  description = "Pause/resume and inspect Corvis Scheduler jobs and Cloud Tasks queues."
  stage       = "GA"
  permissions = [
    "cloudscheduler.jobs.get",
    "cloudscheduler.jobs.pause",
    "cloudscheduler.jobs.resume",
    "cloudtasks.queues.get",
    "cloudtasks.queues.pause",
    "cloudtasks.queues.resume",
  ]
}

resource "google_project_iam_member" "cost_guard_control" {
  project = var.project_id
  role    = google_project_iam_custom_role.cost_guard.name
  member  = "serviceAccount:${google_service_account.cost_guard.email}"
}

# The deploy identity can impersonate the narrow cost-guard identity only so the
# manual status/resume workflow does not need broad Scheduler/Tasks privileges.
resource "google_service_account_iam_member" "deployer_impersonates_cost_guard" {
  service_account_id = google_service_account.cost_guard.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${local.deployer_service_account_email}"
}

resource "terraform_data" "image_guard" {
  lifecycle {
    precondition {
      condition     = !local.runtime_enabled || can(regex("@sha256:[0-9a-fA-F]{64}$", var.api_image))
      error_message = "gcp-cost-guard api_image must be an immutable digest reference ending in @sha256:<64 hex chars>."
    }
  }
}

# Pub/Sub mints the OIDC push token as the cost-guard identity. Materialize the
# managed Pub/Sub service agent before granting its token-creation permission.
resource "google_project_service_identity" "pubsub" {
  count    = local.runtime_enabled ? 1 : 0
  provider = google-beta
  project  = var.project_id
  service  = "pubsub.googleapis.com"
}

resource "google_service_account_iam_member" "pubsub_token_creator" {
  count              = local.runtime_enabled ? 1 : 0
  service_account_id = google_service_account.cost_guard.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_project_service_identity.pubsub[0].email}"
}

resource "google_cloud_run_v2_service" "cost_guard" {
  count    = local.runtime_enabled ? 1 : 0
  project  = var.project_id
  name     = local.service_name
  location = var.region

  # Pub/Sub push reaches the default service URL. Network reachability is not
  # authorization: the service has no allUsers binding and only the dedicated
  # cost-guard service account receives roles/run.invoker below.
  ingress = "INGRESS_TRAFFIC_ALL"

  deletion_protection = var.environment == "prod" && !var.decommission_mode

  template {
    service_account = google_service_account.cost_guard.email

    max_instance_request_concurrency = 4

    scaling {
      min_instance_count = 0
      max_instance_count = 1
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
        name  = "CORVIS_GCP_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "CORVIS_GCP_REGION"
        value = var.region
      }
      env {
        name  = "CORVIS_BUDGET_DISPLAY_NAME"
        value = local.budget_display_name
      }
      env {
        name  = "CORVIS_BUDGET_GUARD_THRESHOLD"
        value = tostring(var.guard_threshold)
      }
      env {
        name  = "CORVIS_BUDGET_GUARD_AUDIENCE"
        value = local.audience
      }
      env {
        name  = "CORVIS_BUDGET_GUARD_SERVICE_ACCOUNT"
        value = google_service_account.cost_guard.email
      }
      env {
        name  = "CORVIS_MONTHLY_BUDGET_USD"
        value = tostring(var.monthly_budget_amount_usd)
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
      error_message = "cost-guard runtime must remain pinned to an immutable API image digest."
    }
  }

  depends_on = [
    terraform_data.image_guard,
    google_project_iam_member.cost_guard_control,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "cost_guard_invoker" {
  count = local.runtime_enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.cost_guard[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.cost_guard.email}"
}

resource "google_pubsub_subscription" "budget_guard" {
  count = local.runtime_enabled ? 1 : 0

  project = var.project_id
  name    = "corvis-budget-guard-${var.environment}"
  topic   = google_pubsub_topic.budget_updates.id

  ack_deadline_seconds       = 60
  message_retention_duration = "86400s"

  push_config {
    push_endpoint = "${google_cloud_run_v2_service.cost_guard[0].uri}/api/internal/budget-guard"

    oidc_token {
      service_account_email = google_service_account.cost_guard.email
      audience              = local.audience
    }
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  expiration_policy {
    ttl = ""
  }

  depends_on = [
    google_cloud_run_v2_service_iam_member.cost_guard_invoker,
    google_service_account_iam_member.pubsub_token_creator,
  ]
}
