# Cloud Monitoring alerting/dashboard/budget derived from ops/slos.yaml, the
# machine-readable SLO/RPO/RTO source of truth (docs/README.md). Each alert
# policy here corresponds to one entry in ops/slos.yaml's `alerts:` list.
#
# Two of the four SLO alert conditions are deliberately NOT implemented here:
# `cross_tenant_authorization_failure_detected` and
# `published_fact_source_reference_coverage` have no corresponding structured
# telemetry emitted by the application today (lib/server/telemetry.ts has no
# such event). A log-based metric filtering for an event that is never
# written would be a permanently silent, false-confidence alert — worse than
# no alert. Wiring these requires adding the underlying application
# instrumentation first (issue #9's own remaining-gap list).

locals {
  api_monitoring_enabled   = trimspace(var.api_service_name) != ""
  dlq_monitoring_enabled   = trimspace(var.dead_letter_topic_name) != ""
  queue_monitoring_enabled = trimspace(var.processing_queue_name) != ""
  budget_enabled           = trimspace(var.billing_account_id) != ""
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
    display_name = "Dead-letter topic has undelivered messages for 15m"

    condition_threshold {
      filter          = "resource.type=\"pubsub_topic\" AND resource.labels.topic_id=\"${var.dead_letter_topic_name}\" AND metric.type=\"pubsub.googleapis.com/topic/num_undelivered_messages\""
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
    content   = "Document-processing dead-letter topic is holding undelivered messages. Investigate via ops/RUNBOOK.md before messages age out."
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
            title = "Dead-letter topic undelivered messages"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "resource.type=\"pubsub_topic\" AND resource.labels.topic_id=\"${var.dead_letter_topic_name}\" AND metric.type=\"pubsub.googleapis.com/topic/num_undelivered_messages\""
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

# Cost telemetry/budget (issue #9's "Cloud Run, GCS, Pub/Sub/Tasks,
# Supabase/Postgres and Cloudflare health/cost attribution and budgets").
# Billing-account access is bootstrap-level (docs/GITHUB_ENVIRONMENTS.md), so
# this stays optional until that access exists.
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
    for_each = [0.5, 0.8, 1.0]
    content {
      threshold_percent = threshold_rules.value
      spend_basis       = "CURRENT_SPEND"
    }
  }

  all_updates_rule {
    monitoring_notification_channels = var.notification_channel_ids
    disable_default_iam_recipients   = false
  }
}
