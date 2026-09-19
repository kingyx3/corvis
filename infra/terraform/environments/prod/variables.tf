variable "project_id" { type = string }
variable "source_bucket_name" { type = string }

variable "cloudflare_zone_id" {
  type    = string
  default = ""
}

variable "customer_hostname" {
  type    = string
  default = ""
}

variable "admin_hostname" {
  type    = string
  default = ""
}

variable "api_hostname" {
  type    = string
  default = ""
}

variable "origin_ipv4_address" {
  description = "Derived external HTTPS load balancer IPv4 address."
  type        = string
  default     = ""
}

variable "enable_cloudflare_managed_waf" {
  type    = bool
  default = false
}
