locals {
  ai_integration_secret_ids = {
    provider_credentials  = "corvis-ai-provider-credentials-${var.environment}"
    litellm_master_key    = "corvis-litellm-master-key-${var.environment}"
    atlassian_skill_read  = "corvis-atlassian-skill-read-${var.environment}"
    atlassian_skill_write = "corvis-atlassian-skill-update-${var.environment}"
  }
}

# Values are never managed by Terraform. GitHub Actions may add versions through the
# narrowly-scoped version-adder grants below; deployed gateway/harness identities receive
# accessor grants separately when those runtimes are provisioned.
resource "google_secret_manager_secret" "ai_integration" {
  for_each = local.ai_integration_secret_ids

  project   = var.project_id
  secret_id = each.value

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
}

resource "google_secret_manager_secret_iam_member" "deployer_ai_integration_version_adder" {
  for_each = google_secret_manager_secret.ai_integration

  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretVersionAdder"
  member    = "serviceAccount:${local.deployer_service_account_email}"
}
