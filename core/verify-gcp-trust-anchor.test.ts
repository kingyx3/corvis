import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = join(process.cwd(), ".github/scripts/verify-gcp-trust-anchor.sh");

const PROJECT_NUMBER = "123456789012";
const POOL = "corvis-github";
const PROVIDER = "github-uat";
const SUBJECT = "repo:kingyx3/corvis:environment:uat";
const SUBJECT_MEMBER = `principal://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/subject/${SUBJECT}`;
const CANONICAL = `assertion.sub == '${SUBJECT}' && assertion.ref == 'refs/heads/main'`;

// Stands in for gcloud: answers the three calls the verifier makes from JSON files.
const FAKE_GCLOUD = `#!/usr/bin/env bash
case "$*" in
  "projects describe"*) echo "${PROJECT_NUMBER}" ;;
  "iam workload-identity-pools providers describe"*) cat "$FAKE_PROVIDER_JSON" ;;
  "iam service-accounts get-iam-policy"*) cat "$FAKE_POLICY_JSON" ;;
  *) echo "unexpected gcloud call: $*" >&2; exit 2 ;;
esac
`;

function provider(attributeCondition: string | undefined, mapping: Record<string, string> = { "google.subject": "assertion.sub" }): string {
  return JSON.stringify({ attributeMapping: mapping, ...(attributeCondition === undefined ? {} : { attributeCondition }) });
}

function policy(members: string[] = [SUBJECT_MEMBER]): string {
  return JSON.stringify({ bindings: [{ role: "roles/iam.workloadIdentityUser", members }] });
}

function run(providerJson: string, policyJson: string = policy()) {
  const dir = mkdtempSync(join(tmpdir(), "trust-anchor-"));
  try {
    writeFileSync(join(dir, "gcloud"), FAKE_GCLOUD);
    chmodSync(join(dir, "gcloud"), 0o755);
    writeFileSync(join(dir, "provider.json"), providerJson);
    writeFileSync(join(dir, "policy.json"), policyJson);
    const result = spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        NODE_ENV: "test",
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        GCP_PROJECT_ID: "corvis-uat",
        GCP_WIF_PROVIDER: `projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}`,
        GCP_DEPLOY_SERVICE_ACCOUNT: "corvis-deploy@corvis-uat.iam.gserviceaccount.com",
        CORVIS_ENVIRONMENT: "uat",
        FAKE_PROVIDER_JSON: join(dir, "provider.json"),
        FAKE_POLICY_JSON: join(dir, "policy.json"),
      },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertRejected(condition: string | undefined) {
  const result = run(provider(condition));
  assert.notEqual(result.status, 0, `expected ${JSON.stringify(condition)} to be rejected\n${result.output}`);
  assert.match(result.output, /attributeCondition must be exactly/);
}

test("the documented subject and ref condition passes", () => {
  const result = run(provider(CANONICAL));
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Verified WIF trust anchor/);
});

test("clause order, spacing and double quotes do not matter", () => {
  assert.equal(run(provider(`assertion.ref == "refs/heads/main"&&assertion.sub == "${SUBJECT}"`)).status, 0);
  assert.equal(run(provider(`assertion.ref == 'refs/heads/main'  &&  assertion.sub == '${SUBJECT}'`)).status, 0);
});

test("the repository + environment + ref claim form passes", () => {
  const condition = "assertion.repository == 'kingyx3/corvis' && assertion.environment == 'uat' && assertion.ref == 'refs/heads/main'";
  const result = run(provider(condition));
  assert.equal(result.status, 0, result.output);
});

test("a negated ref clause is rejected even though it contains the expected text", () => {
  assertRejected(`assertion.sub == '${SUBJECT}' && assertion.ref != 'refs/heads/main'`);
  assertRejected("assertion.repository == 'kingyx3/corvis' && assertion.environment == 'uat' && assertion.ref != 'refs/heads/main'");
});

test("an || clause that widens admission is rejected", () => {
  assertRejected(`${CANONICAL} || assertion.repository_owner == 'kingyx3'`);
  assertRejected(`assertion.sub == '${SUBJECT}' || assertion.ref == 'refs/heads/main'`);
  assertRejected(`assertion.sub == '${SUBJECT}' && assertion.ref == 'refs/heads/main' || true`);
});

test("extra clauses, parentheses, duplicate claims and wildcard-style matching are rejected", () => {
  assertRejected(`${CANONICAL} && assertion.actor == 'someone'`);
  assertRejected(`(${CANONICAL})`);
  assertRejected(`assertion.sub == '${SUBJECT}' && assertion.ref == 'refs/heads/main' && assertion.ref == 'refs/heads/main'`);
  assertRejected(`assertion.sub.startsWith('repo:kingyx3/corvis') && assertion.ref == 'refs/heads/main'`);
  assertRejected(`assertion.sub == '${SUBJECT}' && assertion.ref.startsWith('refs/heads/main')`);
  assertRejected(`assertion.sub == '${SUBJECT}' && assertion.ref == 'refs/heads/main-evil'`);
  assertRejected(`'${SUBJECT}' in assertion.sub && 'refs/heads/main' in assertion.ref`);
});

test("conditions for another repository, environment or ref are rejected", () => {
  assertRejected("assertion.sub == 'repo:other/corvis:environment:uat' && assertion.ref == 'refs/heads/main'");
  assertRejected("assertion.sub == 'repo:kingyx3/corvis:environment:prod' && assertion.ref == 'refs/heads/main'");
  assertRejected(`assertion.sub == '${SUBJECT}' && assertion.ref == 'refs/heads/dev'`);
  assertRejected(`assertion.sub == '${SUBJECT}'`);
  assertRejected("assertion.repository == 'kingyx3/corvis' && assertion.ref == 'refs/heads/main'");
});

test("a missing or empty condition is rejected", () => {
  assertRejected(undefined);
  assertRejected("");
});

test("the google.subject mapping and the service-account binding are still enforced", () => {
  const wrongMapping = run(provider(CANONICAL, { "google.subject": "assertion.actor" }));
  assert.notEqual(wrongMapping.status, 0);
  assert.match(wrongMapping.output, /google\.subject to assertion\.sub/);

  const wrongMember = run(provider(CANONICAL), policy(["principal://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/corvis-github/subject/repo:other/corvis:environment:uat"]));
  assert.notEqual(wrongMember.status, 0);
  assert.match(wrongMember.output, /roles\/iam\.workloadIdentityUser/);
});
