# Services

Code that runs outside the Next.js web app. Each service has its own Dockerfile and is built by `.github/workflows/build-release.yml` into a separately attested image.

| Service | Runs as | Notes |
| --- | --- | --- |
| `control-loop/` | Cloud Run Job (scheduled) and a GitHub Actions workflow | Repository and business-control scanner. See `docs/operations/CONTROL_LOOP.md`. Runtime state is written to `services/control-loop/state/` (git-ignored) or, in production, to GCS under `control-loop/<environment>`. |
| `extractor/` | Cloud Run service | Document-interpretation endpoint behind the processing pipeline. |
| `litellm-gateway/` | Cloud Run service | Pinned LiteLLM gateway for governed AI access. See `docs/architecture/AI_MODEL_GATEWAY.md`. |

Build contexts: the repository root is the context for `control-loop` and `extractor`. A `Dockerfile.dockerignore` next to a Dockerfile replaces the root `.dockerignore` for that image, so `control-loop/` keeps the repository snapshot it scans and `extractor/` ships a single file. `litellm-gateway/` uses its own directory as context.

A service must not import from `src/`. Shared logic belongs in a module or `src/platform/`, which a service can only reach through an explicit, reviewed dependency.
