variable "project_id" { type = string }
variable "region" { type = string default = "asia-southeast1" }
variable "environment" { type = string }
variable "cloud_run_service_name" { type = string }
variable "cloud_run_service_uri" { type = string sensitive = true }
variable "deployer_service_account_email" { type = string }
