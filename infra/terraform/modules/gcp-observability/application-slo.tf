# Application-emitted SLO signals. These resources are intentionally separate
# from main.tf so every log metric has a corresponding application event before
# it becomes an alert. See lib/server/telemetry.ts and ops/slos.yaml.

resource "google_logging_metric" "upload_initiation_duration" {
  project = var.project_id
  name    = "corvis_${var.environment}_upload_initiation_duration_ms"
  filter  = <<-FILTER
    resource.type="cloud_run_revision"
    jsonPayload.event="metric.duration"
    jsonPayload.metric="upload.initiation"
  FILTER

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "ms"
  }

  value_extractor = "EXTRACT(jsonPayload.durationMs)"

  bucket_options {
    exponential_buckets {
      num_finite_buckets = 20
      growth_factor      = 2
      scale              = 10
    }
  }
}

resource "google_monitoring_alert_policy" "upload_initiation_latency" {
  count = local.api_monitoring_enabled ? 1 : 0

  project      = var.project_id
  display_name = "corvis-${var.environment}-upload-initiation-p95"
  combiner     = "OR"
  severity     = "ERROR"

  conditions {
    display_name = "Upload initiation p95 above 500ms for 10m"

    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.upload_initiation_duration.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 500
      duration        = "600s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_PERCENTILE_95"
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = var.notification_channel_ids

  documentation {
    content   = "Upload initiation p95 exceeded the 500ms control-plane objective in ops/slos.yaml. Correlate metric.duration events by correlationId before changing the budget."
    mime_type = "text/markdown"
  }
}

# Publication itself is fail-closed at 100% source-reference coverage. The
# actionable production signal is therefore an attempted publication that the
# gate rejected specifically for incomplete lineage, rather than a misleading
# metric suggesting partially-lined published data can exist.
resource "google_logging_metric" "publication_incomplete_lineage_block" {
  project = var.project_id
  name    = "corvis_${var.environment}_publication_incomplete_lineage_block"
  filter  = <<-FILTER
    resource.type="cloud_run_revision"
    jsonPayload.event="snapshot.publication_blocked"
    jsonPayload.reasons="incomplete_source_lineage"
  FILTER

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "publication_incomplete_lineage_block" {
  count = local.api_monitoring_enabled ? 1 : 0

  project      = var.project_id
  display_name = "corvis-${var.environment}-publication-incomplete-lineage"
  combiner     = "OR"
  severity     = "ERROR"

  conditions {
    display_name = "Publication attempt blocked by incomplete source lineage"

    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.publication_incomplete_lineage_block.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_SUM"
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = var.notification_channel_ids

  documentation {
    content   = "The publication gate rejected an attempted publish because source-reference coverage was below 100%. Published data remains fail-closed; investigate missing lineage before retrying."
    mime_type = "text/markdown"
  }
}

# Existing API error handling already emits this event. We deliberately expose
# it as a queryable metric without mapping it to the SEV1 cross-tenant alert:
# a generic 403 does not prove a cross-tenant attempt, and treating it as one
# would create noisy false positives.
resource "google_logging_metric" "authorization_denied" {
  project = var.project_id
  name    = "corvis_${var.environment}_authorization_denied"
  filter  = <<-FILTER
    resource.type="cloud_run_revision"
    jsonPayload.event="api.authorization_denied"
  FILTER

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}
