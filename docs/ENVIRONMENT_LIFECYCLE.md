# Cloud environment lifecycle

Corvis cloud environments are disposable except for the minimum provider trust anchor needed to recreate them safely. Routine operation stays GitHub-only after the initial GCP OIDC/WIF trust relationship exists.

## Lifecycle model

```text
Initial provider trust
        |
        v
Bootstrap GCP foundation
        |
        | creates/hardens remote Terraform state
        | creates durable Terraform foundation
        | adopts retained KMS anchor when re-provisioning
        v
Build + Terraform deploy
        |
        v
Running environment
        |
        |------------------------------|
        v                              v
Idle decommission                 Full decommission
(runtime + public edge off)       (data/resources/state removed)
        |                              |
        |                              | retains only project/WIF/deploy SA
        |                              | + disabled KMS key/key-ring anchor
        v                              v
Terraform deploy                 Bootstrap GCP foundation
(re-provision runtime)           (recreate state + foundation)
```

## Bootstrap owns Terraform state

`Bootstrap GCP foundation` is the only workflow allowed to create the remote state bucket. It configures the bucket with uniform bucket-level access, public-access prevention, object versioning, soft delete disabled, and lifecycle cleanup for noncurrent state versions after 30 days or once more than 20 newer versions exist.

Normal `Terraform deploy` never recreates a missing backend. If state has been fully decommissioned, deployment fails closed and instructs the operator to run bootstrap first. This prevents an empty state file from accidentally treating existing resources as unmanaged.

A full decommission removes the remote state bucket only after Terraform reports an empty managed-resource state.

## Idle decommission

Use **Decommission GCP environment** with `mode=idle` when an environment is temporarily unused but its durable data/control foundation must remain available.

Idle mode removes the deployed Cloud Run API and public API Gateway/Cloudflare edge. It retains the source bucket, KMS, Artifact Registry, queues, service identities, Secret Manager containers, observability configuration and remote Terraform state. Re-provision by building a release and running the normal Terraform deploy workflow.

Idle apply requires an exact `IDLE <environment>` confirmation and must run from `main`.

## Full decommission

Use `mode=full` only when the entire environment and its Terraform-managed data may be deleted. Full apply requires the exact confirmation `DECOMMISSION <environment> DELETE DATA AND STATE` and must run from `main`.

The workflow performs teardown in this order:

1. resolves the current immutable Cloud Run image and applies a lifecycle-preparation plan so production deletion protection is removed only for this guarded operation and source storage becomes purgeable;
2. detaches the KMS key/key-ring from Terraform state so the provider cannot irreversibly destroy the bootstrap encryption anchor;
3. runs `terraform destroy` for the remaining managed resources, including source data, Artifact Registry, queues, runtime services, IAM bindings, secrets and observability resources;
4. refuses to continue unless Terraform state is empty;
5. removes automatic KMS rotation and disables enabled key versions;
6. deletes the versioned remote Terraform state bucket last.

The GCP project, GitHub WIF trust, `corvis-deploy` service account and the disabled KMS key/key-ring remain as bootstrap anchors. They do not expose a running Corvis workload. On the next bootstrap, the workflow recreates the state bucket, imports the retained KMS resources into the new state automatically, re-enables the primary key version, and recreates the Terraform foundation.

## Safety boundaries

Normal bootstrap and deployment set `decommission_mode=false`. The source bucket is therefore not force-destroyable and production Cloud Run keeps deletion protection. Only the guarded decommission workflow sets `decommission_mode=true`.

Full mode is intentionally destructive: customer/source bytes, runtime secret resources, images, known-good rollback manifests and Terraform state are deleted. Use idle mode when the goal is only to stop unused runtime cost while preserving durable environment state.
