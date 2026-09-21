resource "google_service_account" "control_loop" {
  project      = var.project_id
  account_id   = "corvis-control-loop-${var.environment}"
  display_name = "Corvis control loop ${var.environment}"
  description  = "Keyless runtime identity for the scheduled Corvis business/control reconciliation job."
}

resource "google_project_iam_member" "control_loop_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.control_loop.email}"
}

resource "google_storage_bucket" "control_loop_state" {
  project                     = var.project_id
  name                        = "${var.project_id}-corvis-control-loop-${var.environment}"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = var.decommission_mode
  labels                      = local.labels

  versioning {
    enabled = true
  }

  depends_on = [google_project_service.required]
}

resource "google_storage_bucket_iam_member" "control_loop_state_objects" {
  bucket = google_storage_bucket.control_loop_state.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.control_loop.email}"
}

resource "google_service_account_iam_member" "deployer_act_as_control_loop" {
  service_account_id = google_service_account.control_loop.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${local.deployer_service_account_email}"
}
