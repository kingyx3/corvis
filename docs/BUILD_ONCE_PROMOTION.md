# Build-once cross-project release promotion

Corvis production-like releases use UAT as the canonical build registry. A reviewed `main` commit is built and attested once in the UAT Artifact Registry; production receives the exact OCI images by cross-project copy. Production does not rebuild the same source commit.

## Release path

```text
protected main
    |
    v
Build release image (GitHub Environment: uat)
    |
    +-- api:git-<sha> ----------+
    |                           |
    +-- control-loop:git-<sha> -+--> attested immutable UAT digests
                                |
                                v
                    Copy UAT release to prod
                                |
              UAT repository reader trust only
                                |
                                v
                    gcrane copy + digest equality
                                |
                                v
                     prod Artifact Registry
                                |
                                v
                 Terraform deploy -> acceptance
                                |
                                v
                       known-good release set
```

## Trust model

The copy workflow derives both GCP project IDs from their existing GitHub Environments. No additional project-ID variable or static credential is introduced.

Before copying, the UAT `corvis-deploy` identity reconciles one repository-scoped IAM binding: the derived prod `corvis-deploy@<prod-project>.iam.gserviceaccount.com` identity receives `roles/artifactregistry.reader` on the UAT `corvis` repository. It does not receive writer/admin access to UAT. The prod deploy identity uses its existing prod permissions to write the copied image into the prod repository.

All authentication remains GitHub OIDC -> GCP Workload Identity Federation.

## Copy invariants

For both `api` and `control-loop`:

1. resolve `uat/.../<image>:git-<release_sha>` to its OCI digest;
2. refuse the promotion if a prod tag with the same commit already points at a different digest;
3. copy the UAT image to the equivalent prod tag with pinned, checksum-verified `gcrane`;
4. resolve the prod image digest after the copy;
5. require prod digest == UAT digest exactly;
6. only then allow the normal Terraform deployment workflow to resolve the prod-local tag and deploy it.

This makes environment promotion a physical artifact promotion rather than a source-code equivalence assumption.

## Operator sequence

For a new production-like release:

1. merge reviewed source to protected `main`;
2. run **Build release image** for `uat`;
3. run **Promote environment** for `uat` with the full release SHA and complete live acceptance;
4. run **Promote environment** for `prod` with the same release SHA;
5. the parent prod workflow automatically reconciles source read trust and copies/verifies both OCI images before migrations/Terraform can start;
6. production acceptance advances `known-good.json` only after all required live acceptance families pass.

`Build release image` intentionally offers only `dev` and `uat`; `prod` is not a valid build target.

## Provider activation dependency

The workflow is fully defined before UAT exists, but it cannot execute until the real UAT and prod GCP projects, WIF providers, deploy identities and Artifact Registry repositories have been bootstrapped. Those are external trust roots, not missing application code.
