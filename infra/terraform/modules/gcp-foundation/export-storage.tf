# Physical export artifacts are immutable per delivery attempt. The worker only
# needs create authority in the private source/artifact bucket; API retrieval
# remains behind authenticated application authorization and the API's existing
# object access. Bucket administration and object deletion are intentionally not
# granted to the worker.
resource "google_storage_bucket_iam_member" "worker_export_creator" {
  bucket = google_storage_bucket.source.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.worker.email}"
}
