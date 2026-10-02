# AI model gateway and extraction harness

GitHub is the technical source of truth for how Corvis connects governed extraction to AI models and agent harnesses. The business/extraction semantics remain defined by the authoritative Confluence skill and reference library; this document defines the runtime boundary, configuration and security contract.

## Goals

Corvis must be able to change or combine model providers without changing the canonical data model, review workflow or downstream APIs. A provider, gateway or coding-agent harness is therefore never part of the Corvis domain contract.

The production boundary is:

```text
Corvis worker
  |
  | Google OIDC + POST /v1/extractions
  v
CORVIS_EXTRACTION_ENDPOINT
(governed extraction harness)
  |
  |-- acquire an immutable snapshot of the authorized Confluence extraction skill
  |-- acquire/interpret document and workbook evidence
  |-- orchestrate map/reduce/coverage/fund attribution
  |-- call one or more model/harness backends
  |       |
  |       +--> LiteLLM gateway (recommended default)
  |       |       +--> OpenAI
  |       |       +--> Anthropic
  |       |       +--> Gemini / Vertex AI
  |       |       +--> Bedrock / Azure / other supported providers
  |       |       +--> self-hosted OpenAI-compatible inference
  |       |
  |       +--> direct provider or agent-harness adapter when justified
  |
  +--> deterministic candidate JSONL + orchestration manifest in GCS
              |
              v
       Corvis independently verifies
              |
              v
       extraction candidates -> reviewer gate -> canonical facts
```

`CORVIS_EXTRACTION_ENDPOINT` is **not** a raw model endpoint and is **not** the LiteLLM URL. It must implement the Corvis `/v1/extractions` contract already enforced by `lib/server/processing-extracted-stage.ts`.

## Why LiteLLM is inside, not around, Corvis

LiteLLM is the recommended gateway because it provides one model-facing interface over many providers, routing/fallback primitives and support for multiple client/harness protocols. It remains replaceable. Corvis itself does not import a LiteLLM SDK and does not store LiteLLM-specific identifiers in the canonical model.

The extraction harness should use logical aliases rather than vendor model IDs. A baseline alias scheme is:

| Alias | Role |
| --- | --- |
| `corvis-extract-primary` | Main semantic extraction model/pool. |
| `corvis-extract-secondary` | Independent alternate model/pool for ensemble or fallback work. |
| `corvis-extract-verifier` | Independent verification/reconciliation model/pool. |
| `corvis-extract-fast` | Optional low-cost/low-latency model for bounded simple work units. |

Multiple provider deployments may share one alias. Changing the concrete model behind an alias is a gateway/harness deployment change, not a Corvis application-code change. Every accepted bundle must still return the actual `modelProvider`, `modelName` and `modelVersion` so lineage and evaluation remain auditable.

Do not make a single provider name, model ID or LiteLLM deployment name part of candidate identity, canonical taxonomy or reviewer UI assumptions.

## LiteLLM configuration pattern

`ops/litellm/config.example.yaml` is an example only. Production configuration should be rendered outside Git from environment/secret-backed values and the container image must be pinned to an immutable digest.

Provider credentials are referenced from environment variables, never embedded in YAML:

```yaml
model_list:
  - model_name: corvis-extract-primary
    litellm_params:
      model: openai/<approved-model-id>
      api_key: os.environ/OPENAI_API_KEY

  - model_name: corvis-extract-primary
    litellm_params:
      model: anthropic/<approved-model-id>
      api_key: os.environ/ANTHROPIC_API_KEY

  - model_name: corvis-extract-verifier
    litellm_params:
      model: gemini/<approved-model-id>
      api_key: os.environ/GEMINI_API_KEY
```

The same abstraction may point at Vertex, Bedrock, Azure or an OpenAI-compatible self-hosted backend. Provider-specific authentication that can use workload identity should prefer workload identity over static keys.

## GitHub configuration and secret flow

Non-secret connection settings are GitHub Environment **variables** and are propagated to Terraform:

- `CORVIS_EXTRACTION_ENDPOINT`: approved HTTPS extraction-harness endpoint; empty means fail-closed.
- `CORVIS_EXTRACTION_AUDIENCE`: optional Google OIDC audience; application code defaults to the endpoint.
- `CORVIS_EXTRACTION_TIMEOUT_MS`: bounded provider-call timeout, default `20000`.

Sensitive integration values are GitHub Environment **secrets used only as provisioning inputs** by **AI integration secret provisioning**. The workflow writes new versions to Terraform-managed GCP Secret Manager containers and never prints the values:

- `CORVIS_AI_PROVIDER_CREDENTIALS_JSON` -> `corvis-ai-provider-credentials-<env>`
- `CORVIS_LITELLM_MASTER_KEY` -> `corvis-litellm-master-key-<env>`
- `CORVIS_ATLASSIAN_SKILL_READ_CREDENTIALS_JSON` -> `corvis-atlassian-skill-read-<env>`
- `CORVIS_ATLASSIAN_SKILL_UPDATE_CREDENTIALS_JSON` -> `corvis-atlassian-skill-update-<env>`

The provider credential JSON is intentionally vendor-neutral. It is a JSON object of environment-variable names to secret strings, for example:

```json
{
  "OPENAI_API_KEY": "...",
  "ANTHROPIC_API_KEY": "...",
  "GEMINI_API_KEY": "..."
}
```

Only include credentials actually used in that environment. A gateway/harness entrypoint may materialize those values as process environment variables after validating the keys. Do not expose the JSON to models, prompts, candidate bundles or logs.

The Terraform module grants the deployment identity permission to **add versions only** to these integration secrets. It intentionally does not grant the Corvis API/worker service accounts access to provider or Atlassian credentials. The future extraction-harness and LiteLLM runtime service accounts must receive only the individual `secretAccessor` grants they need.

## Confluence extraction skill access

The authoritative quarterly-report skill is currently:

- **AI Extraction Skill — Quarterly Fund Reports**
- Confluence page ID: `426007`
- Space: `FUNDATA`
- URL: `https://corvis.atlassian.net/wiki/spaces/FUNDATA/pages/426007/AI+Extraction+Skill+Quarterly+Fund+Reports`

The harness must load an authorized skill snapshot at the beginning of an extraction run and keep that snapshot stable for the entire run. A model must not silently switch to a newly edited skill midway through one extraction.

Credentials are separated by capability:

1. **Skill read credential** — mounted into the normal extraction harness. It may read the authoritative skill/reference content needed for execution, but should have no content-update permission where the Atlassian permission model allows that distinction.
2. **Skill update credential** — mounted only into an explicitly invoked skill-maintenance path. Normal extraction does not receive it.

The model never receives either credential. The harness resolves the Confluence content and provides only the necessary skill/context text to the model.

### Skill-learning/update loop

Corvis may improve extraction instructions as the reviewed corpus grows, but an individual model run must not self-authorize a production skill change. The maintenance path should:

1. collect reviewed extraction failures, exceptions and recurring document patterns;
2. reproduce them in an evaluation corpus;
3. propose a narrow skill/reference update with the evidence that motivated it;
4. run the old and proposed skill against the evaluation corpus;
5. require the configured governance/review rule before publishing the Confluence update; and
6. retain the Confluence version/page identity used by each subsequent extraction run.

Where fully automated publishing is later approved, it still uses the separate update credential and must emit an auditable page version/comment. A normal extraction model or LiteLLM virtual key never gets Confluence write authority.

## Model ensembles and evaluation

Ensembling is an orchestration strategy, not an instruction to call every model for every page. The harness may use primary/secondary/verifier aliases based on document complexity, historical evaluation results and the consequence of an error.

Recommended evaluation dimensions are:

- completeness/coverage;
- exact numeric accuracy;
- period and unit accuracy;
- entity/fund/holding attribution accuracy;
- citation/source-reference accuracy;
- false-positive rate;
- exception detection;
- reviewer correction rate;
- latency; and
- inference cost.

Reviewed candidate/correction history is the appropriate source for a growing benchmark. Model routing should be changed from evidence, not brand preference. For high-risk verification, prefer an independently configured verifier (and, when practical, a different provider/model family) rather than asking the same model to grade itself.

## Spreadsheet/workbook semantics

Spreadsheets are **not** treated as fixed templates and `spreadsheet_parser` is not an authoritative semantic mapper. GP workbooks can vary by manager, quarter, export tool and manual editing history even when they carry the same business meaning.

For workbooks, deterministic tooling is evidence acquisition and validation:

- preserve sheet names/order and hidden-sheet state when available;
- preserve cells/ranges, formulas and displayed values as separate evidence where available;
- preserve merged ranges, named ranges, comments/notes and formatting that carries units or period semantics;
- preserve row/column labels and exact cell/range source references;
- avoid flattening cross-sheet relationships before semantic interpretation;
- use deterministic checks for totals, units, periods, formula consistency and duplicate evidence where useful.

The AI/harness layer then performs semantic interpretation across sheets and ranges: locating equivalent concepts despite layout drift, resolving period/unit context, identifying fund/company/holding scope, following cross-sheet references and mapping source-reported values into Corvis candidates.

A template fingerprint may be used later as an optimization or context hint after evaluation, but correctness must not depend on a workbook matching a known template. Unknown or changed layouts must fall back to semantic interpretation rather than silently applying a stale column map.

The existing Corvis rule remains: company operating values are extracted at the full source-reported value unless the source itself reports an ownership-adjusted value; the extraction layer must not invent ownership proration.

## Harness/coding-agent support

A general agent harness such as Codex/Claude Code can be connected behind the extraction service for specialized workflows, but it must be constrained to the same governed inputs and outputs. Filesystem/tool access is not a substitute for the Corvis evidence contract.

For production extraction, a harness must not:

- write canonical Postgres facts directly;
- bypass deterministic GCS bundle identity/hash checks;
- publish facts without source references and required confidence/provenance;
- acquire arbitrary tenant data outside the run scope;
- obtain the Confluence update credential merely because it can read the skill; or
- mutate repository/Confluence content as a side effect of ordinary extraction.

Harnesses may be useful for the separately governed skill-maintenance loop, where repository/Confluence tools are explicitly part of the authorized task.

## Activation sequence

1. Apply the environment Terraform so the AI integration Secret Manager containers exist.
2. Configure any required GitHub Environment provisioning secrets.
3. Run **AI integration secret provisioning** for UAT/prod. The workflow rotates only values that are present; it refuses a no-op run.
4. Deploy the model gateway and extraction harness with dedicated service accounts and least-privilege access to the required Secret Manager entries, GCS evidence objects and Confluence read/update capability.
5. Configure `CORVIS_EXTRACTION_ENDPOINT` (and optional audience/timeout) in the GitHub Environment.
6. Run Terraform deploy. The worker receives only the non-secret endpoint/audience/timeout; the extracted stage remains absent when the endpoint is empty.
7. Validate the extraction harness against the representative quarterly-report corpus before promotion.

No model-provider key or Atlassian credential is required merely to bootstrap the Corvis GCP foundation.
