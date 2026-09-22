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

# Durable processing counters are emitted only after the corresponding
# Postgres stage transition has committed. Duplicate/busy deliveries therefore
# do not inflate accepted/completed populations.
resource "google_logging_metric" "pipeline_accepted" {
  project = var.project_id
  name    = "corvis_${var.environment}_pipeline_accepted"
  filter  = <<-FILTER
    resource.type="cloud_run_revision"
    jsonPayload.event="metric.count"
    jsonPayload.metric="document_pipeline.accepted"
  FILTER

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "pipeline_completed" {
  project = var.project_id
  name    = "corvis_${var.environment}_pipeline_completed"
  filter  = <<-FILTER
    resource.type="cloud_run_revision"
    jsonPayload.event="metric.count"
    jsonPayload.metric="document_pipeline.completed"
  FILTER

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "pipeline_dead_letter" {
  project = var.project_id
  name    = "corvis_${var.environment}_pipeline_dead_letter"
  filter  = <<-FILTER
    resource.type="cloud_run_revision"
    jsonPayload.event="metric.count"
    jsonPayload.metric="document_pipeline.dead_letter"
  FILTER

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

# Publication freshness is measured from the persisted source document
# created_at to the persisted publication_run completed_at. This intentionally
# avoids request-time approximations or inferred timestamps.
resource "google_logging_metric" "publication_freshness_duration" {
  project = var.project_id
  name    = "corvis_${var.environment}_publication_freshness_ms"
  filter  = <<-FILTER
    resource.type="cloud_run_revision"
    jsonPayload.event="metric.duration"
    jsonPayload.metric="document_pipeline.publication_freshness"
  FILTER

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "ms"
  }

  value_extractor = "EXTRACT(jsonPayload.durationMs)"

  bucket_options {
    exponential_buckets {
      num_finite_buckets = 24
      growth_factor      = 2
      scale              = 1000
    }
  }
}

resource "google_monitoring_alert_policy" "publication_freshness" {
  count = local.api_monitoring_enabled ? 1 : 0

  project      = var.project_id
  display_name = "corvis-${var.environment}-publication-freshness-p95"
  combiner     = "OR"
  severity     = "ERROR"

  conditions {
    display_name = "Publication freshness p95 above 60m for 10m"

    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.publication_freshness_duration.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 3600000
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
    content   = "Persisted document-created to publication-completed p95 exceeded the 60-minute objective in ops/slos.yaml. Inspect durable stage/retry/review state before adjusting the objective."
    mime_type = "text/markdown"
  }
}

# Delivery telemetry is derived from the durable export/webhook ledgers. Retry
# attempts remain visible in raw logs; these counters deliberately distinguish
# completed work from terminal failure so live UAT can establish a real health
# baseline before an external delivery SLO is committed.
resource "google_logging_metric" "export_delivery_complete" {
  project = var.project_id
  name    = "corvis_${var.environment}_export_delivery_complete"
  filter  = <<-FILTER
    resource.type="cloud_run_revision"
    jsonPayload.event="metric.count"
    jsonPayload.metric="delivery.export"
    jsonPayload.outcome="complete"
  FILTER

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "export_delivery_failed" {
  project = var.project_id
  name    = "corvis_${var.environment}_export_delivery_failed"
  filter  = <<-FILTER
    resource.type="cloud_run_revision"
    jsonPayload.event="metric.count"
    jsonPayload.metric="delivery.export"
    jsonPayload.outcome="failed"
  FILTER

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "export_delivery_duration" {
  project = var.project_id
  name    = "corvis_${var.environment}_export_delivery_duration_ms"
  filter  = <<-FILTER
    resource.type="cloud_run_revision"
    jsonPayload.event="metric.duration"
    jsonPayload.metric="delivery.export"
  FILTER

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "ms"
  }

  value_extractor = "EXTRACT(jsonPayload.durationMs)"

  bucket_options {
    exponential_buckets {
      num_finite_buckets = 24
      growth_factor      = 2
      scale              = 1000
    }
  }
}

resource "google_logging_metric" "webhook_delivery_complete" {
  project = var.project_id
  name    = "corvis_${var.environment}_webhook_delivery_complete"
  filter  = <<-FILTER
    resource.type="cloud_run_revision"
    jsonPayload.event="metric.count"
    jsonPayload.metric="delivery.webhook"
    jsonPayload.outcome="complete"
  FILTER

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "webhook_delivery_failed" {
  project = var.project_id
  name    = "corvis_${var.environment}_webhook_delivery_failed"
  filter  = <<-FILTER
    resource.type="cloud_run_revision"
    jsonPayload.event="metric.count"
    jsonPayload.metric="delivery.webhook"
    jsonPayload.outcome="failed"
  FILTER

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "webhook_delivery_duration" {
  project = var.project_id
  name    = "corvis_${var.environment}_webhook_delivery_duration_ms"
  filter  = <<-FILTER
    resource.type="cloud_run_revision"
    jsonPayload.event="metric.duration"
    jsonPayload.metric="delivery.webhook"
  FILTER

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "ms"
  }

  value_extractor = "EXTRACT(jsonPayload.durationMs)"

  bucket_options {
    exponential_buckets {
      num_finite_buckets = 24
      growth_factor      = 2
      scale              = 1000
    }
  }
}
