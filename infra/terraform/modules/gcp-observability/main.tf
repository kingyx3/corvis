# Cloud Monitoring alerting/dashboard/budget derived from ops/slos.yaml, the
# machine-readable SLO/RPO/RTO source of truth (docs/README.md). Alert policies
# live in this file or application-slo.tf depending on whether the source signal
# is provider-native or application-emitted.
#
# The true cross-tenant SEV1 condition remains deliberately unwired here:
# `cross_tenant_authorization_failure_detected` requires a real tenant-boundary
# mismatch signal, not a generic 403. A log metric filtering for an event that
# is never emitted would be false-confidence monitoring, so that detector stays
# UAT/provider-bound until the deployed authorization path can prove its semantics.

locals {
  api_monitoring_enabled   = trimspace(var.api_service_name) != ""
  dlq_monitoring_enabled   = trimspace(var.dead_letter_subscription_name) != ""
  queue_monitoring_enabled = trimspace(var.processing_queue_name) != ""
  budget_enabled           = trimspace(var.billing_account_id) != ""
  uptime_enabled           = trimspace(var.uptime_check_host) != ""
}

# ops/slos.yaml: "api_5xx_rate > 0.02 for 10m", severity SEV2.
resource "google_monitoring_alert_policy" "api_5xx_rate" {
  count = local.api_monitoring_enabled ? 1 : 0

  project      = var.project_id
  display_name = "corvis-${var.environment}-api-5xx-rate"
  combiner     = "OR"
  severity     = "ERROR"

  conditions {
    display_name = "API 5xx rate above 2% for 10m"

    condition_monitoring_query_language {
      duration = "600s"
      trigger {
        count = 1
      }
      # Ratio of 5xx to total Cloud Run request count for the API service,
      # rate-aligned over 5 minute windows. Verify against a live project
      # during UAT setup: an MQL query is opaque to `terraform validate` and
      # is only checked by the Monitoring API at apply time.
      query = <<-MQL
        fetch cloud_run_revision
        | metric 'run.googleapis.com/request_count'
        | filter resource.service_name == '${var.api_service_name}'
        | align rate(5m)
        | group_by [], [total: sum(value.request_count)]
        | { ident
          ; fetch cloud_run_revision
            | metric 'run.googleapis.com/request_count'
            | filter resource.service_name == '${var.api_service_name}'
              && metric.response_code_class == '5xx'
            | align rate(5m)
            | group_by [], [five_xx: sum(value.request_count)]
          }
        | join
        | value [ratio: val(1) / val(0)]
        | condition ratio > 0.02
      MQL
    }
  }

  notification_channels = var.notification_channel_ids

  documentation {
    content   = "API 5xx error rate exceeded the ops/slos.yaml web_api availability target (99.9%). See docs/INFRASTRUCTURE.md and ops/RUNBOOK.md."
    mime_type = "text/markdown"
  }
}

# ops/slos.yaml: "dead_letter_queue_depth > 0 for 15m", severity SEV2.
resource "google_monitoring_alert_policy" "dead_letter_queue_depth" {
  count = local.dlq_monitoring_enabled ? 1 : 0

  project      = var.project_id
  display_name = "corvis-${var.environment}-dead-letter-queue-depth"
  combiner     = "OR"
  severity     = "ERROR"

  conditions {
    display_name = "Dead-letter subscription has undelivered messages for 15m"

    condition_threshold {
      filter          = "resource.type=\"pubsub_subscription\" AND resource.labels.subscription_id=\"${var.dead_letter_subscription_name}\" AND metric.type=\"pubsub.googleapis.com/subscription/num_undelivered_messages\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "900s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MAX"
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = var.notification_channel_ids

  documentation {
    content   = "Document-processing dead-letter subscription is holding undelivered messages. Investigate via ops/RUNBOOK.md before messages age out."
    mime_type = "text/markdown"
  }
}

# Supplementary to the SLO alert list: surfaces the processing queue's own
# depth so a growing backlog is visible before anything reaches dead-letter.
resource "google_monitoring_alert_policy" "processing_queue_depth" {
  count = local.queue_monitoring_enabled ? 1 : 0

  project      = var.project_id
  display_name = "corvis-${var.environment}-processing-queue-depth"
  combiner     = "OR"
  severity     = "WARNING"

  conditions {
    display_name = "Processing queue depth sustained above baseline for 15m"

    condition_threshold {
      filter          = "resource.type=\"cloud_tasks_queue\" AND resource.labels.queue_id=\"${var.processing_queue_name}\" AND metric.type=\"cloudtasks.googleapis.com/queue/depth\""
      comparison      = "COMPARISON_GT"
      threshold_value = 500
      duration        = "900s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = var.notification_channel_ids

  documentation {
    content   = "Processing queue depth is sustained above the provisional 500-task baseline. Tune this threshold once real load data exists (issue #9)."
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_dashboard" "slo_overview" {
  count = local.api_monitoring_enabled || local.dlq_monitoring_enabled ? 1 : 0

  project = var.project_id

  dashboard_json = jsonencode({
    displayName = "Corvis ${var.environment} SLO overview"
    mosaicLayout = {
      columns = 12
      tiles = concat(
        local.api_monitoring_enabled ? [{
          width  = 6
          height = 4
          widget = {
            title = "API request count by response code class"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${var.api_service_name}\" AND metric.type=\"run.googleapis.com/request_count\""
                    aggregation = {
                      alignmentPeriod    = "300s"
                      perSeriesAligner   = "ALIGN_RATE"
                      crossSeriesReducer = "REDUCE_SUM"
                      groupByFields      = ["metric.label.response_code_class"]
                    }
                  }
                }
                plotType = "STACKED_AREA"
              }]
            }
          }
        }] : [],
        local.dlq_monitoring_enabled ? [{
          width  = 6
          height = 4
          widget = {
            title = "Dead-letter subscription undelivered messages"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "resource.type=\"pubsub_subscription\" AND resource.labels.subscription_id=\"${var.dead_letter_subscription_name}\" AND metric.type=\"pubsub.googleapis.com/subscription/num_undelivered_messages\""
                    aggregation = {
                      alignmentPeriod  = "300s"
                      perSeriesAligner = "ALIGN_MAX"
                    }
                  }
                }
                plotType = "LINE"
              }]
            }
          }
        }] : [],
        local.queue_monitoring_enabled ? [{
          width  = 6
          height = 4
          widget = {
            title = "Processing queue depth"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "resource.type=\"cloud_tasks_queue\" AND resource.labels.queue_id=\"${var.processing_queue_name}\" AND metric.type=\"cloudtasks.googleapis.com/queue/depth\""
                    aggregation = {
                      alignmentPeriod  = "300s"
                      perSeriesAligner = "ALIGN_MEAN"
                    }
                  }
                }
                plotType = "LINE"
              }]
            }
          }
        }] : [],
      )
    }
  })
}

# The Billing Budget API requires the Pub/Sub topic to exist before attaching it
# to a budget. Keeping the topic in the observability module makes that graph
# dependency explicit; the production-like cost guard consumes this topic.
resource "google_pubsub_topic" "budget_updates" {
  project = var.project_id
  name    = "corvis-budget-updates-${var.environment}"

  labels = merge(
    {
      service     = "corvis-cost-guard"
      environment = var.environment
      managed_by  = "terraform"
    },
    var.labels,
  )
}

# Cost telemetry/budget (issue #9's "Cloud Run, GCS, Pub/Sub/Tasks,
# Supabase/Postgres and Cloudflare health/cost attribution and budgets").
# Billing-account access is bootstrap-level (docs/GITHUB_ENVIRONMENTS.md), so
# this stays optional until that access exists. Programmatic notifications are
# deliberately non-destructive: the UAT cost guard pauses automated work at 85%
# rather than disabling billing or deleting the project.
resource "google_billing_budget" "monthly" {
  count = local.budget_enabled ? 1 : 0

  billing_account = var.billing_account_id
  display_name    = "corvis-${var.environment}-monthly-budget"

  budget_filter {
    projects = ["projects/${var.project_id}"]
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.monthly_budget_amount_usd)
    }
  }

  dynamic "threshold_rules" {
    for_each = [0.5, 0.75, 0.85, 1.0]
    content {
      threshold_percent = threshold_rules.value
      spend_basis       = "CURRENT_SPEND"
    }
  }

  all_updates_rule {
    pubsub_topic                     = google_pubsub_topic.budget_updates.id
    schema_version                   = "1.0"
    monitoring_notification_channels = var.notification_channel_ids
    disable_default_iam_recipients   = false
  }
}

# ops/slos.yaml web_api availability 99.9%: an external probe of the public API
# path (Cloudflare -> API Gateway -> Cloud Run) that also requires configuration
# and Postgres to be healthy (/api/v1/health/ready), from several regions (#235).
resource "google_monitoring_uptime_check_config" "api_ready" {
  count = local.uptime_enabled ? 1 : 0

  project      = var.project_id
  display_name = "corvis-${var.environment}-api-ready"
  timeout      = "10s"
  period       = "60s"

  http_check {
    path         = "/api/v1/health/ready"
    port         = 443
    use_ssl      = true
    validate_ssl = true

    accepted_response_status_codes {
      status_class = "STATUS_CLASS_2XX"
    }
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = trimspace(var.uptime_check_host)
    }
  }
}

resource "google_monitoring_alert_policy" "api_uptime" {
  count = local.uptime_enabled ? 1 : 0

  project      = var.project_id
  display_name = "corvis-${var.environment}-api-uptime"
  combiner     = "OR"
  severity     = "CRITICAL"

  conditions {
    display_name = "Public API readiness failing from multiple regions for 5m"

    condition_threshold {
      filter          = "resource.type=\"uptime_url\" AND metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.label.check_id=\"${google_monitoring_uptime_check_config.api_ready[0].uptime_check_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "300s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.project_id", "resource.label.host"]
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = var.notification_channel_ids

  documentation {
    content   = "The public API readiness probe (https://${trimspace(var.uptime_check_host)}/api/v1/health/ready) is failing from more than one checker region. Check Cloudflare, API Gateway, Cloud Run revisions and Postgres (ops/RUNBOOK.md)."
    mime_type = "text/markdown"
  }
}
