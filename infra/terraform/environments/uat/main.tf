terraform {
  required_version = ">= 1.7.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = "asia-southeast1"
}

module "foundation" {
  source             = "../../modules/gcp-foundation"
  project_id         = var.project_id
  environment        = "uat"
  source_bucket_name = var.source_bucket_name
}
