variable "account_id" { type = string }
variable "zone_id" { type = string }
variable "customer_hostname" { type = string }
variable "customer_gateway_hostname" { type = string }
variable "customer_gateway_api_key" { type = string sensitive = true }
variable "api_gateway_hostname" { type = string }
variable "api_gateway_api_key" { type = string sensitive = true }
