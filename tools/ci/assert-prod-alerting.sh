#!/usr/bin/env bash
# Fail closed when a production runtime would be deployed with inert alerting.
#
# monitoring_notification_channel_ids defaults to [] so alert policies exist but
# notify nobody. That is acceptable for dev/uat, never for a prod runtime.
#
# Environment:
#   CORVIS_ENVIRONMENT                          dev | uat | prod
#   TF_VAR_api_image                            non-empty when a runtime is being deployed
#   TF_VAR_monitoring_notification_channel_ids  JSON array of channel ids ('[]' or blank = none)
set -euo pipefail

: "${CORVIS_ENVIRONMENT:?CORVIS_ENVIRONMENT is required}"

if [[ "${CORVIS_ENVIRONMENT}" != "prod" || -z "${TF_VAR_api_image:-}" ]]; then
  echo "Alerting channel guard not applicable (environment=${CORVIS_ENVIRONMENT}, runtime image $([[ -n "${TF_VAR_api_image:-}" ]] && echo set || echo unset))."
  exit 0
fi

channels="${TF_VAR_monitoring_notification_channel_ids:-}"

if jq -e 'type == "array" and any(.[]; type == "string" and (gsub("\\s"; "") | length) > 0)' <<< "${channels:-null}" >/dev/null 2>&1; then
  echo "Production alerting has at least one notification channel configured."
  exit 0
fi

echo "Refusing to deploy a production runtime without monitoring notification channels."
echo "MONITORING_NOTIFICATION_CHANNEL_IDS is empty, '[]' or not a JSON array of channel ids, so every"
echo "alert policy would fire into nothing. Set it on the prod GitHub Environment, for example:"
echo '  ["projects/<project>/notificationChannels/<id>"]'
exit 1
