# AWS reference: immutable source storage

This module is a replaceable infrastructure adapter, not a Corvis domain dependency.

It provisions a private, versioned S3 source bucket with KMS encryption, public-access blocking, bucket-owner enforcement, TLS-only policy and abandoned-multipart cleanup. Production should add organization-specific IAM, VPC endpoint restrictions, malware/quarantine integration, logging, backup/replication and retention/legal-hold controls before deployment.

Object keys must remain tenant scoped, for example:

`env/<environment>/tenant=<tenant_id>/document=<document_id>/artifact=<artifact_version_id>/original/<safe_filename>`

Classification, fund name and inferred metadata must not be used as durable object identity.

If Corvis is deployed on another cloud, replace this module while preserving the upload/session and artifact-registry contracts.