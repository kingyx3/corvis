# Application-emitted SLO signals. These resources are intentionally separate
# from main.tf so every log metric has a corresponding application event before
# it becomes an alert. See src/platform/telemetry.ts and ops/slos.yaml.

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

# processing-transport.ts emits this count when an outbox event exhausts its
# publish attempts (migration 021 sets transport_dead_lettered_at). Nothing
# retries such an event on its own, so any occurrence pages the operator, who
# requeues it with POST /api/v1/admin/processing-transport/dead-letters (#230).
resource "google_logging_metric" "processing_transport_dead_letter" {
  project = var.project_id
  name    = "corvis_${var.environment}_processing_transport_dead_letter"
  filter  = <<-FILTER
    resource.type="cloud_run_revision"
    jsonPayload.event="metric.count"
    jsonPayload.metric="processing.transport.dead_letter"
  FILTER

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "processing_transport_dead_letter" {
  count = local.api_monitoring_enabled ? 1 : 0

  project      = var.project_id
  display_name = "corvis-${var.environment}-processing-transport-dead-letter"
  combiner     = "OR"
  severity     = "ERROR"

  conditions {
    display_name = "Processing outbox event dead-lettered by the transport"

    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.processing_transport_dead_letter.name}\""
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
    content   = "A document-processing outbox event exhausted its publish attempts and is dead-lettered; its document stays registered until it is requeued. List and requeue it with GET/POST /api/v1/admin/processing-transport/dead-letters after fixing the cause (ops/RUNBOOK.md)."
    mime_type = "text/markdown"
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

# ops/slos.yaml web_api latency_ms.p95 = 750: request latency from Cloud Run's
# own distribution metric, 95th percentile across the API service's revisions.
resource "google_monitoring_alert_policy" "api_latency_p95" {
  count = local.api_monitoring_enabled ? 1 : 0

  project      = var.project_id
  display_name = "corvis-${var.environment}-api-latency-p95"
  combiner     = "OR"
  severity     = "WARNING"

  conditions {
    display_name = "API p95 latency above 750ms for 15m"

    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${var.api_service_name}\" AND metric.type=\"run.googleapis.com/request_latencies\""
      comparison      = "COMPARISON_GT"
      threshold_value = 750
      duration        = "900s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_PERCENTILE_95"
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = var.notification_channel_ids

  documentation {
    content   = "API p95 latency exceeded the ops/slos.yaml web_api objective (750ms). Check Postgres pool waits (CORVIS_POSTGRES_POOL_MAX, request concurrency) and cold starts before changing the budget."
    mime_type = "text/markdown"
  }
}

# src/app/api/internal/delivery logs delivery.task_failed for each scheduler-tick
# task (exports, webhooks, processing transport, sweeps) that rejected. The
# tick answers 500 so the scheduler retries; persistent failure pages here.
resource "google_logging_metric" "delivery_task_failed" {
  project = var.project_id
  name    = "corvis_${var.environment}_delivery_task_failed"
  filter  = <<-FILTER
    resource.type="cloud_run_revision"
    jsonPayload.event="delivery.task_failed"
  FILTER

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "delivery_task_failed" {
  count = local.api_monitoring_enabled ? 1 : 0

  project      = var.project_id
  display_name = "corvis-${var.environment}-worker-delivery-task-failed"
  combiner     = "OR"
  severity     = "ERROR"

  conditions {
    display_name = "Worker scheduler tick task failing for 15m"

    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.delivery_task_failed.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "900s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = var.notification_channel_ids

  documentation {
    content   = "A task in the worker's scheduled delivery tick (exports, webhooks, processing transport, idempotency/webhook/upload sweeps or upload release) has failed on every tick for 15 minutes. The delivery.task_failed log names the task."
    mime_type = "text/markdown"
  }
}

# F7d (#337). src/modules/identity-access/server/authorization.ts times every session policy check
# (metric.duration "auth.session_policy", tagged with the verdict, so its count
# is the denominator of the denial rate) and counts every denial
# (metric.count "auth.session_policy_denied", tagged with the reason:
# idle_timeout, max_session, untracked_session or unknown). Neither carries a
# subject or a session id. A burst of denials is a policy that is too tight, an
# identity provider that stopped sending a stable session id (untracked_session)
# or a fail-closed lookup (unknown); see docs/features/TENANT_SELF_SERVICE.md.
resource "google_logging_metric" "session_policy_enforcement_duration" {
  project = var.project_id
  name    = "corvis_${var.environment}_session_policy_enforcement_duration_ms"
  filter  = <<-FILTER
    resource.type="cloud_run_revision"
    jsonPayload.event="metric.duration"
    jsonPayload.metric="auth.session_policy"
  FILTER

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "ms"
  }

  value_extractor = "EXTRACT(jsonPayload.durationMs)"

  bucket_options {
    exponential_buckets {
      num_finite_buckets = 16
      growth_factor      = 2
      scale              = 1
    }
  }
}

resource "google_logging_metric" "session_policy_denied" {
  project = var.project_id
  name    = "corvis_${var.environment}_session_policy_denied"
  filter  = <<-FILTER
    resource.type="cloud_run_revision"
    jsonPayload.event="metric.count"
    jsonPayload.metric="auth.session_policy_denied"
  FILTER

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"

    labels {
      key         = "reason"
      value_type  = "STRING"
      description = "Why the session policy ended the session: idle_timeout, max_session, untracked_session or unknown."
    }
  }

  label_extractors = {
    reason = "EXTRACT(jsonPayload.reason)"
  }
}

# Every authorized request pays for one session policy check, so a slow check
# is a slow API. The check is one indexed Postgres call; 100ms at p95 is far
# above its normal cost and well inside the web_api latency objective.
resource "google_monitoring_alert_policy" "session_policy_enforcement_latency" {
  count = local.api_monitoring_enabled ? 1 : 0

  project      = var.project_id
  display_name = "corvis-${var.environment}-session-policy-enforcement-p95"
  combiner     = "OR"
  severity     = "WARNING"

  conditions {
    display_name = "Session policy enforcement p95 above 100ms for 15m"

    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.session_policy_enforcement_duration.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 100
      duration        = "900s"

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
    content   = "Checking an organization's session policy (corvis_control.enforce_session_policy) is slow for 15 minutes; every authorized request pays for it. Check Postgres pool waits and the tenant_session_activity table size and its housekeeping (the sessionActivitySweep task of the delivery tick) before changing the threshold (docs/features/TENANT_SELF_SERVICE.md)."
    mime_type = "text/markdown"
  }
}

# Denials are expected (that is the policy working), so the alert is a rate far
# above the normal background: more than 200 in 5 minutes, sustained for 10.
resource "google_monitoring_alert_policy" "session_policy_denials" {
  count = local.api_monitoring_enabled ? 1 : 0

  project      = var.project_id
  display_name = "corvis-${var.environment}-session-policy-denials"
  combiner     = "OR"
  severity     = "WARNING"

  conditions {
    display_name = "More than 200 session policy denials per 5m for 10m"

    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.session_policy_denied.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 200
      duration        = "600s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = var.notification_channel_ids

  documentation {
    content   = "Session policy denials (auth.session_policy_denied) are far above the usual rate. Group by the reason label: idle_timeout or max_session means an organization's limits are tighter than its people's working pattern; untracked_session means the identity provider stopped sending a stable session id (sid or jti) while a limit is set, which refuses everyone; unknown means the policy check answered nothing and failed closed (docs/features/TENANT_SELF_SERVICE.md)."
    mime_type = "text/markdown"
  }
}
