# Security Policy

## Reporting a vulnerability

Please do not disclose security vulnerabilities in public GitHub issues.

Use [GitHub's private vulnerability reporting](https://github.com/kingyx3/corvis/security/advisories/new) ("Security" tab → "Report a vulnerability"). This is the sole reporting channel: it works without any prior relationship with Corvis, notifies the repository's administrators directly, and keeps the report private until a fix ships. If that link is unavailable, open a draft security advisory from the repository's Security tab instead.

A useful report includes:

- affected component and version/commit;
- reproduction steps;
- potential tenant/customer-data impact;
- proof of concept where safe;
- suggested mitigation if known.

## Response principles

Corvis will triage reports based on exploitability, confidentiality/integrity/availability impact, tenant-isolation impact and customer-data exposure risk. Confirmed findings should receive an owner, severity, remediation target and verification evidence.

Do not include real customer documents, credentials, tokens or confidential customer data in vulnerability reports.

## CI/CD supply-chain controls

Executable third-party GitHub Actions used by Corvis workflows and composite actions are pinned to full immutable commit SHAs. Human-readable major versions remain beside the pinned references for review context, and GitHub Actions dependencies remain under weekly Dependabot review. Repository tests fail if a mutable external action tag, branch or other non-immutable `uses:` reference is introduced.

## Scope priorities

The highest-priority surfaces include authentication and tenant isolation, document upload/processing, source-evidence access, APIs/exports, Snowflake serving controls, AI retrieval, secrets and privileged administration.
