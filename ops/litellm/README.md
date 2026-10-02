# Corvis LiteLLM gateway package

This directory provides the provider-neutral gateway layer used **behind** a Corvis extraction harness. It is not itself a `CORVIS_EXTRACTION_ENDPOINT`: LiteLLM exposes model/harness APIs, while the Corvis endpoint must implement `/v1/extractions`, acquire the authorized skill/evidence, enforce the orchestration policy and write immutable GCS candidate output.

See [`../../docs/AI_MODEL_GATEWAY.md`](../../docs/AI_MODEL_GATEWAY.md) for the end-to-end contract.

## Files

- `config.example.yaml` — logical Corvis model aliases with environment-backed provider credentials. Copy/render it outside Git for each environment and replace `<approved-model-id>` placeholders.
- `entrypoint.py` — validates `CORVIS_AI_PROVIDER_CREDENTIALS_JSON`, materializes individual provider environment variables without logging values, removes the aggregate JSON from the child environment and starts LiteLLM.
- `Dockerfile` — thin wrapper around an upstream LiteLLM image. The build has no mutable default; the caller must provide an immutable digest with `--build-arg LITELLM_BASE_IMAGE=...@sha256:...`.

## Runtime inputs

The gateway runtime should receive only the secrets/configuration it needs:

- `CORVIS_AI_PROVIDER_CREDENTIALS_JSON` — JSON object mapping provider environment-variable names to credentials. The wrapper rejects process-control and Corvis/LiteLLM control-plane names.
- `LITELLM_MASTER_KEY` — gateway root credential, supplied separately from provider credentials.
- `CORVIS_LITELLM_CONFIG` — optional rendered config path; defaults to `/app/corvis-litellm.yaml`.
- `PORT` — optional listen port; defaults to `4000`.

The repository's `config.example.yaml` is intentionally not copied to the default live config path. A production image/deployment must supply an explicit environment-approved config rather than accidentally starting with placeholder model IDs.

## Secret Manager sources

After applying Terraform, the following containers exist per UAT/prod environment:

- `corvis-ai-provider-credentials-<env>`
- `corvis-litellm-master-key-<env>`
- `corvis-atlassian-skill-read-<env>`
- `corvis-atlassian-skill-update-<env>`

Run the **AI integration secret provisioning** workflow to rotate selected values from protected GitHub Environment secrets into those containers. Terraform manages container/IAM existence only; it never stores secret values in state.

Do not grant the LiteLLM service account the Atlassian skill credentials. Those belong to the extraction harness. Conversely, the Corvis API/worker does not need provider credentials or the LiteLLM master key.

## Database choice

The baseline gateway config does not require a LiteLLM database. Add a separately governed database only when features such as persistent virtual keys, spend logs or Admin UI model management are required. Do not point LiteLLM at the Corvis canonical application database.

## Harness clients

The same gateway can serve ordinary model clients and supported agent/coding harnesses. Use separately scoped model aliases/virtual keys for a coding harness where possible. A harness connected through LiteLLM still must obey the Corvis extraction boundary: it cannot write canonical facts, bypass GCS evidence validation or obtain Confluence write authority during an ordinary extraction run.
