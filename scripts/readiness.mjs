import { access, readFile } from "node:fs/promises";

const requirements = [
  ["OIDC + tenant authorization", "server/security.ts", ["code_challenge_method", "tenantClaim", "requireSession"]],
  ["quarantined multipart ingestion", "server/platform.ts", ["quarantine/tenant=", "scanObject", "MAGIC_BYTE_MISMATCH", "ETag mismatch"]],
  ["tenant-filtered retrieval", "server/snowflake.ts", ["source_document_access_allowed", "tenant_id", "@and"]],
  ["governed semantic research", "server/research.ts", ["semantic_query", "document_search", "untrusted evidence"]],
  ["Snowflake tenant policy", "snowflake/migrations/001_enterprise_platform.sql", ["ROW ACCESS POLICY", "ROLE_TENANT_ACCESS", "PM_SERVING"]],
  ["Cortex Search", "snowflake/migrations/002_cortex_search.sql", ["CORTEX SEARCH SERVICE", "SOURCE_DOCUMENT_ACCESS_ALLOWED"]],
  ["security scanning", ".github/workflows/codeql.yml", ["codeql"]],
  ["dependency automation", ".github/dependabot.yml", ["npm", "github-actions"]],
  ["incident response", "docs/runbooks/incident-response.md", ["SEV1", "contain"]],
  ["backup and DR", "docs/runbooks/disaster-recovery.md", ["RPO", "RTO", "restore"]],
  ["operational SLOs", "docs/operations/slo.md", ["availability", "freshness"]],
  ["data lifecycle", "docs/governance/data-retention.md", ["retention", "deletion"]],
  ["IaC object-store baseline", "infra/terraform/main.tf", ["aws_s3_bucket", "aws_kms_key"]],
];

const failures = [];
for (const [name, path, tokens] of requirements) {
  try {
    await access(path);
    const text = await readFile(path, "utf8");
    for (const token of tokens) if (!text.toLowerCase().includes(token.toLowerCase())) failures.push(`${name}: ${path} is missing ${token}`);
  } catch {
    failures.push(`${name}: missing ${path}`);
  }
}

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
if (packageJson.dependencies?.next !== "16.3.5") failures.push("Next.js must be pinned to the verified version");
if (packageJson.dependencies?.react !== "19.3.0") failures.push("React must be pinned to the verified version");
if (packageJson.scripts?.check === undefined) failures.push("package.json must expose the complete check gate");

if (failures.length) {
  console.error(`Enterprise-readiness assertions failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}
console.info(`Enterprise-readiness assertions passed (${requirements.length} control families).`);
