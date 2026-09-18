output "document_bucket_name" {
  value = aws_s3_bucket.documents.bucket
}

output "document_bucket_arn" {
  value = aws_s3_bucket.documents.arn
}

output "document_bucket_endpoint" {
  value = "https://${aws_s3_bucket.documents.bucket}.s3.${var.aws_region}.amazonaws.com"
}

output "kms_key_arn" {
  value = aws_kms_key.documents.arn
}

output "application_policy_arn" {
  value = aws_iam_policy.application_documents.arn
}
