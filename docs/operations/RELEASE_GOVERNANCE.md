# Release governance trust boundary

Corvis release workflows fail closed unless the exact release commit is already on `main`, every required GitHub Actions check succeeded for that commit, and the effective `main` ruleset is active, strict, and non-bypassable.

The live ruleset requires five GitHub Actions contexts: `frontend`, `rate-limit-postgres`, `Analyze TypeScript`, `secret-history`, and `forbidden-artifacts`. `frontend` waits for quality, Dockerfile lint, Terraform, build, all browser tests, non-demo smoke, and **container** validation; any failed, cancelled or skipped dependency fails the aggregate. The release verifier additionally requires a successful exact-commit `container` check, without requiring a sixth independent ruleset context. Container build, runtime smoke and vulnerability scanning therefore remain mandatory at both merge and release boundaries.

## GitHub App credential

`RELEASE_GOVERNANCE_TOKEN` is retained as the historical secret name, but **it must not contain a PAT**. Store a GitHub App credential object in each `dev`, `uat`, and `prod` GitHub Environment:

```json
{
  "appId": "123456",
  "privateKey": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
}
```

The App must be installed only on `kingyx3/corvis` and have these repository permissions:

- Administration: **Read and write** (required to see ruleset bypass actors);
- Checks: **Read**;
- Contents: **Read**;
- Environments: **Read** (required to verify each environment's deployment branch policy; requested only when a workflow names environments, see below);
- Metadata: implicit read.

`tools/ci/release-governance.mjs` signs a short-lived App JWT, resolves the installation for the current repository, and requests a repository-scoped installation token for each workflow invocation. The verifier accepts that `ghs_` installation token internally and explicitly rejects fine-grained or classic long-lived PAT credentials.

Rotate the GitHub App private key on the same cadence as other high-trust release credentials and immediately revoke an exposed key in GitHub App settings.

## GitHub Environment protection

Repository code cannot set GitHub Environment protection, so configure it explicitly. It can notice drift, and it does: every workflow that runs `release-governance.mjs` also reads the deployment branch policy of the environments whose secrets it uses (`RELEASE_ENVIRONMENTS`: the input environment for build-release and terraform-deploy; `uat,prod` for the shared Cloudflare zone policy) and fails unless each one is a **custom branch policy that allows exactly the branch `main`**. "All branches" and "protected branches" are refused, as are extra branch or tag patterns. The GitHub App therefore also needs the Environments read permission above; without it the governed workflows fail on the read rather than skip the check.

- `dev`: deployment branches/tags restricted to `main` only;
- `uat`: deployment branches/tags restricted to `main` only;
- `prod`: deployment branches/tags restricted to `main` only and required reviewers enabled when an independent operator is available;
- prevent administrators from bypassing environment protection for production whenever the account/plan supports it.

Corvis also verifies the GCP Workload Identity Provider condition during bootstrap. The accepted trust condition is repository + environment + `assertion.ref == 'refs/heads/main'`; a repo-wide or environment-only principal is rejected.

In the current documented solo-maintainer operating mode, GitHub cannot provide an independent human approval without deadlocking releases. The release workflows therefore add machine-enforced compensating controls: non-bypassable PR governance, exact-commit required checks, a rendered Terraform plan digest that must match at apply time, UAT-known-good digest promotion, and post-deploy live acceptance. Move `prod` to independent required reviewers as soon as a second release operator exists.

## Terraform plan/apply control

Production-like promotion runs Terraform twice deliberately:

1. `plan` checks out the requested release SHA, resolves immutable release digests, renders the plan, and publishes the plan text plus SHA-256 in the job summary/artifact.
2. `apply` checks out the same release SHA, reproduces the plan, refuses to continue unless its rendered SHA-256 exactly matches the reviewed value, then applies the exact local `tfplan` it just verified.

The binary `tfplan` is never accepted from an unrelated run. This avoids applying a stale or substituted artifact while still making the complete reviewed text and digest available before the protected apply job starts.

Known-good rollback skips forward migrations. Normal migrations execute from the exact release checkout rather than workflow `main` HEAD.

## Release image control

Production release tags are immutable at the Artifact Registry repository level. New `git-<sha>` tags may be created but cannot be moved or deleted. UAT remains cleanup-capable, but production promotion never trusts a UAT tag: it requires the acceptance-written `known-good.json`, matches its `sourceSha`, verifies GitHub provenance for each accepted digest, then copies those exact OCI digests into production.

Release builds emit BuildKit max-mode provenance, SPDX SBOM attestations, and GitHub artifact attestations for API/worker, control-loop, extractor, and LiteLLM images.
