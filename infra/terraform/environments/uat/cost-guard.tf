# UAT cost guard: Cloud Billing publishes estimated spend updates to the
# observability-owned topic. At 85% of the monthly budget, an IAM-private,
# scale-to-zero Cloud Run endpoint pauses automated Scheduler work and the
# processing queue. It never disables billing, deletes data or tears down UAT.
module "cost_guard" {
  source                    = "../../modules/gcp-cost-guard"
  project_id                = var.project_id
  environment               = "uat"
  api_image                 = var.api_image
  budget_pubsub_topic       = module.observability.budget_pubsub_topic
  monthly_budget_amount_usd = var.monthly_budget_amount_usd
  guard_threshold           = 0.85
  decommission_mode         = var.decommission_mode

  depends_on = [module.observability]
}
