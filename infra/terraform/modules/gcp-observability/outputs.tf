output "budget_pubsub_topic" {
  description = "Fully qualified Pub/Sub topic used for Cloud Billing budget programmatic notifications."
  value       = google_pubsub_topic.budget_updates.id
}
