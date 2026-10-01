# Physical export artifacts are immutable per delivery attempt. The worker needs
# create authority in the private source/artifact bucket; API retrieval remains
# behind authenticated application authorization and the API's existing object
# access. Deleting a failed or superseded attempt's object (exports/ prefix) is
# granted separately and only under an IAM condition by
# google_storage_bucket_iam_member.worker_source_objects in main.tf. Bucket
# administration is intentionally not granted to the worker.
resource "google_storage_bucket_iam_member" "worker_export_creator" {
  bucket = google_storage_bucket.source.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.worker.email}"
}
