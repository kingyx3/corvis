terraform {
  required_version = ">= 1.8.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0, < 7.0"
    }
  }
}

variable "name" { type = string }
variable "environment" { type = string }
variable "force_destroy" {
  type    = bool
  default = false
}
variable "noncurrent_version_expiration_days" {
  type    = number
  default = 3650
}
variable "cors_allowed_origins" {
  type        = list(string)
  description = "Exact HTTPS application origins permitted to upload directly to S3. Never use * in production."
  default     = []
}

resource "aws_kms_key" "documents" {
  description             = "Corvis ${var.environment} source-document and queue encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  tags                    = { Service = "corvis", Environment = var.environment, DataClass = "confidential-source" }
}

resource "aws_kms_alias" "documents" {
  name          = "alias/${var.name}-${var.environment}-documents"
  target_key_id = aws_kms_key.documents.key_id
}

resource "aws_s3_bucket" "documents" {
  bucket        = "${var.name}-${var.environment}-documents"
  force_destroy = var.force_destroy
  tags          = { Service = "corvis", Environment = var.environment, DataClass = "confidential-source" }
}

resource "aws_s3_bucket_versioning" "documents" {
  bucket = aws_s3_bucket.documents.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.documents.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "documents" {
  bucket                  = aws_s3_bucket.documents.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_cors_configuration" "documents" {
  count  = length(var.cors_allowed_origins) > 0 ? 1 : 0
  bucket = aws_s3_bucket.documents.id
  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "HEAD", "PUT"]
    allowed_origins = var.cors_allowed_origins
    expose_headers  = ["ETag", "x-amz-version-id", "x-amz-request-id"]
    max_age_seconds = 3600
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
    noncurrent_version_expiration { noncurrent_days = var.noncurrent_version_expiration_days }
  }
}

resource "aws_s3_bucket_policy" "documents" {
  bucket = aws_s3_bucket.documents.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.documents.arn, "${aws_s3_bucket.documents.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      }
    ]
  })
}

resource "aws_sqs_queue" "processing_dlq" {
  name                              = "${var.name}-${var.environment}-processing-dlq"
  kms_master_key_id                 = aws_kms_key.documents.arn
  message_retention_seconds         = 1209600
  kms_data_key_reuse_period_seconds = 300
  tags                              = { Service = "corvis", Environment = var.environment, Purpose = "processing-dead-letter" }
}

resource "aws_sqs_queue" "processing" {
  name                              = "${var.name}-${var.environment}-processing"
  kms_master_key_id                 = aws_kms_key.documents.arn
  visibility_timeout_seconds        = 900
  message_retention_seconds         = 1209600
  receive_wait_time_seconds         = 20
  kms_data_key_reuse_period_seconds = 300
  redrive_policy                    = jsonencode({ deadLetterTargetArn = aws_sqs_queue.processing_dlq.arn, maxReceiveCount = 5 })
  tags                              = { Service = "corvis", Environment = var.environment, Purpose = "processing" }
}

resource "aws_sqs_queue_redrive_allow_policy" "processing_dlq" {
  queue_url            = aws_sqs_queue.processing_dlq.id
  redrive_allow_policy = jsonencode({ redrivePermission = "byQueue", sourceQueueArns = [aws_sqs_queue.processing.arn] })
}

output "bucket_name" { value = aws_s3_bucket.documents.id }
output "kms_key_arn" { value = aws_kms_key.documents.arn }
output "processing_queue_url" { value = aws_sqs_queue.processing.id }
output "processing_dlq_url" { value = aws_sqs_queue.processing_dlq.id }
