# Corvis LiteLLM gateway package

This directory provides the provider-neutral model gateway used **behind** the governed Corvis extraction harness. It is not itself a `CORVIS_EXTRACTION_ENDPOINT`: LiteLLM exposes model APIs, while the Corvis endpoint implements `/v1/extractions`, acquires authorized skill/evidence, enforces orchestration policy and writes immutable GCS candidate output.

See [`../../docs/AI_MODEL_GATEWAY.md`](../../docs/AI_MODEL_GATEWAY.md) and [`../extractor/README.md`](../extractor/README.md) for the end-to-end contract.

## Files

- `config.example.yaml` — illustrative alias/provider syntax only; it is never copied into the live container configuration.
- `entrypoint.py` — validates provider credentials and the non-secret Corvis model map, materializes provider environment variables without logging values, renders an ephemeral LiteLLM config with the gateway master key, removes the aggregate credential JSON from the child environment, and starts LiteLLM.
- `Dockerfile` — thin wrapper around an upstream LiteLLM image. The release build has no mutable default; `CORVIS_LITELLM_BASE_IMAGE` must resolve to an immutable `...@sha256:<digest>` and is passed as `LITELLM_BASE_IMAGE`.

## Runtime inputs

The managed Cloud Run gateway receives only:

- `CORVIS_AI_PROVIDER_CREDENTIALS_JSON` — Secret Manager value mapping provider environment-variable names to credentials. The wrapper rejects process-control and Corvis/LiteLLM control-plane names.
- `LITELLM_MASTER_KEY` — separate Secret Manager gateway credential.
- `CORVIS_LITELLM_MODELS_JSON` — non-secret JSON map of logical Corvis aliases to approved provider/model identifiers, for example `{"corvis-extract-primary":"anthropic/<approved-model-id>","corvis-extract-verifier":"openai/<approved-model-id>"}`.
- `CORVIS_LITELLM_CONFIG` — optional explicit config path for exceptional deployments. When omitted, the entrypoint renders an ephemeral config from the approved model map; production no longer needs a checked-in or manually mounted YAML file.
- `PORT` — optional listen port; managed Cloud Run uses `4000`.

The generated config references provider environment variables rather than embedding their values and sets `general_settings.master_key` from `LITELLM_MASTER_KEY`. The checked-in example can therefore never accidentally become the live configuration with placeholder model IDs.

## Deployment and IAM

`infra/terraform/modules/ai-runtime` creates a dedicated `corvis-litellm-<env>` service account and Cloud Run service when the release-set LiteLLM/extractor images and `CORVIS_LITELLM_MODELS_JSON` are all present. There is no public invoker grant. Only `corvis-extractor-<env>` receives `roles/run.invoker` on LiteLLM; the API and worker do not.

The LiteLLM identity receives `secretAccessor` only for:

- `corvis-ai-provider-credentials-<env>`; and
- `corvis-litellm-master-key-<env>`.

It deliberately receives neither Confluence credential. The extractor receives only the gateway key plus the Confluence read credential; the Corvis API/worker receive neither provider nor LiteLLM credentials. The post-acceptance known-good binding workflow verifies these live IAM/secret boundaries before recording the AI image digests as rollback-safe.

Run **AI integration secret provisioning** to rotate selected values from protected GitHub Environment secrets into the Terraform-managed Secret Manager containers. Terraform manages container/IAM existence only; it never stores secret values in state.

## Database choice

The baseline gateway does not require a LiteLLM database. Add a separately governed database only when persistent virtual keys, spend logs or an administrative model-management surface are explicitly required. Never point LiteLLM at the Corvis canonical application database.

## Claude Code, Codex and other harness clients

LiteLLM remains protocol/provider-neutral, so controlled development or a separately governed maintenance harness may connect Claude Code, Codex or another agent client to logical Corvis aliases. Ordinary production extraction intentionally does **not** depend on a personal Claude/ChatGPT login or an interactive coding-agent process: the managed extractor calls the private gateway with service/provider credentials and emits the same Corvis candidate contract regardless of provider.

If a future coding-agent adapter is enabled for production extraction, it belongs behind the extractor boundary and must retain the same immutable evidence scope, source references, lineage, no-canonical-write rule and lack of Confluence write authority.
