# Corvis governed extraction harness

`server.mjs` is the production boundary behind `CORVIS_EXTRACTION_ENDPOINT`. It implements the existing Corvis `POST /v1/extractions` contract; it is deliberately **not** a raw model proxy.

## Runtime flow

```text
Corvis worker (Google OIDC)
  -> corvis-extractor-<env>
       -> immutable document_interpretation_v1 from the Corvis GCS bucket
       -> one fixed Confluence skill snapshot for the run
       -> bounded semantic work units + global reducer
       -> corvis-litellm-<env> (Google OIDC + LiteLLM key)
       -> provider model(s)
       -> immutable candidate JSONL + orchestration manifest in GCS
  -> Corvis independently re-verifies generation/hash/coverage/lineage
  -> reviewer gate -> canonical facts
```

The extractor has no Postgres credential and cannot publish canonical facts. It receives only the LiteLLM master key, the read-only Atlassian skill credential and GCS object read/create rights. It never receives provider credentials or the Confluence update credential.

## Activation

The normal GitHub-only activation path is:

1. Set GitHub Environment variable `CORVIS_LITELLM_BASE_IMAGE` in the build environment to an immutable upstream LiteLLM image (`...@sha256:<digest>`).
2. Set `CORVIS_LITELLM_MODELS_JSON` in the target environment. Values are logical-alias to provider/model mappings, for example:

   ```json
   {
     "corvis-extract-primary": "anthropic/<approved-model-id>",
     "corvis-extract-verifier": "openai/<approved-model-id>"
   }
   ```

3. Set the existing protected provisioning secrets `CORVIS_AI_PROVIDER_CREDENTIALS_JSON`, `CORVIS_LITELLM_MASTER_KEY` and `CORVIS_ATLASSIAN_SKILL_READ_CREDENTIALS_JSON`, then run **AI integration secret provisioning**. No secret value is stored in Terraform state.
4. Run **Build release image** for UAT. The release now contains API/worker, control-loop, extractor and LiteLLM images, each pinned by digest and attested.
5. Promote/apply the release. Terraform deploys the private LiteLLM/extractor pair only when the model map is configured and refuses activation when the required Secret Manager entries have no enabled version.
6. Read the Terraform outputs `corvis_extraction_endpoint` and `corvis_extraction_audience`; set GitHub Environment variables `CORVIS_EXTRACTION_ENDPOINT` and `CORVIS_EXTRACTION_AUDIENCE` to that private extractor URI, then re-apply the same release. This two-step bootstrap deliberately keeps the worker fail-closed until the target exists.
7. Validate representative quarterly-report packages before production promotion. Production copies the exact four UAT OCI images; it does not rebuild them.

`CORVIS_EXTRACTION_TIMEOUT_MS` defaults to 300000 ms and may be set up to 480000 ms. The extracted-stage budget is 510 seconds and the worker request/ack deadline is 600 seconds, leaving cancellation headroom.

## Claude Code and Codex

Coding-agent clients can use the same LiteLLM gateway for controlled development or separately governed maintenance workflows, but ordinary production extraction does not depend on a personal Claude/ChatGPT subscription or an interactive CLI session. Production inference uses service/provider credentials behind LiteLLM and returns the same provider-neutral Corvis candidate contract. Any future Claude Code/Codex harness adapter belongs inside this service boundary and must retain the same GCS, source-reference, lineage and no-canonical-write rules.
