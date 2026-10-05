import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const releaseGuard = join(process.cwd(), "tools/ci/assert-release-matches-head.sh");
const alertingGuard = join(process.cwd(), "tools/ci/assert-prod-alerting.sh");
const deployWorkflow = readFileSync(".github/workflows/terraform-deploy.yml", "utf8");

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      NODE_ENV: "test",
      PATH: process.env.PATH ?? "",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function write(repo: string, path: string, content: string): void {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function commit(repo: string, message: string): string {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

function withRepo<T>(body: (repo: string) => T): T {
  const repo = mkdtempSync(join(tmpdir(), "release-guard-"));
  try {
    git(repo, "init", "-q", "-b", "main");
    write(repo, "db/schema.sql", "-- v1\n");
    write(repo, "infra/main.tf", "# v1\n");
    write(repo, "docs/README.md", "v1\n");
    return body(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function runReleaseGuard(repo: string, sha: string) {
  const result = spawnSync("bash", [releaseGuard, sha], {
    cwd: repo,
    encoding: "utf8",
    env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: repo },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test("release guard passes when HEAD is the release commit", () => {
  withRepo((repo) => {
    const release = commit(repo, "release");
    const result = runReleaseGuard(repo, release);
    assert.equal(result.status, 0, result.output);
  });
});

test("release guard passes when only unrelated paths changed after the release", () => {
  withRepo((repo) => {
    const release = commit(repo, "release");
    write(repo, "docs/README.md", "v2\n");
    write(repo, "app/page.tsx", "export {};\n");
    commit(repo, "docs and app only");
    const result = runReleaseGuard(repo, release);
    assert.equal(result.status, 0, result.output);
  });
});

test("release guard fails and lists paths when db/ changed after the release", () => {
  withRepo((repo) => {
    const release = commit(repo, "release");
    write(repo, "db/migrations/0002_new.sql", "select 1;\n");
    commit(repo, "new migration");
    const result = runReleaseGuard(repo, release);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /db\/migrations\/0002_new\.sql/);
    assert.match(result.output, /release SHA's commit|re-promote/);
    assert.doesNotMatch(result.output, /docs\/README/);
  });
});

test("release guard fails when infra/ changed after the release", () => {
  withRepo((repo) => {
    const release = commit(repo, "release");
    write(repo, "infra/main.tf", "# v2\n");
    write(repo, "docs/README.md", "v2\n");
    commit(repo, "infra change");
    const result = runReleaseGuard(repo, release);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /infra\/main\.tf/);
    assert.doesNotMatch(result.output, /docs\/README/);
  });
});

test("release guard also fails for a deleted guarded file", () => {
  withRepo((repo) => {
    const release = commit(repo, "release");
    git(repo, "rm", "-q", "db/schema.sql");
    commit(repo, "drop schema");
    const result = runReleaseGuard(repo, release);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /db\/schema\.sql/);
  });
});

test("release guard fails for an unknown or malformed release SHA", () => {
  withRepo((repo) => {
    commit(repo, "release");
    const unknown = runReleaseGuard(repo, "0123456789abcdef0123456789abcdef01234567");
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.output, /not present/);
    for (const bad of ["main", "abc123", "0123456789ABCDEF0123456789ABCDEF01234567"]) {
      assert.notEqual(runReleaseGuard(repo, bad).status, 0, bad);
    }
  });
});

test("release guard refuses shallow clones", () => {
  withRepo((repo) => {
    write(repo, "docs/README.md", "v2\n");
    const first = commit(repo, "first");
    write(repo, "docs/README.md", "v3\n");
    commit(repo, "second");
    const shallow = mkdtempSync(join(tmpdir(), "release-guard-shallow-"));
    try {
      git(shallow, "clone", "-q", "--depth", "1", `file://${repo}`, "clone");
      const result = runReleaseGuard(join(shallow, "clone"), first);
      assert.notEqual(result.status, 0);
      assert.match(result.output, /shallow/);
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
  });
});

function runAlertingGuard(env: Record<string, string>) {
  const result = spawnSync("bash", [alertingGuard], {
    encoding: "utf8",
    env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", ...env },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const image = "asia-southeast1-docker.pkg.dev/p/corvis/api@sha256:" + "a".repeat(64);

test("prod runtime deploy fails closed without notification channels", () => {
  for (const channels of ["[]", "", " ", "[ ]", "[\"\"]", "[\" \"]", "not-json", "{}", "null", "\"chan\""]) {
    const result = runAlertingGuard({
      CORVIS_ENVIRONMENT: "prod",
      TF_VAR_api_image: image,
      TF_VAR_monitoring_notification_channel_ids: channels,
    });
    assert.notEqual(result.status, 0, JSON.stringify(channels));
    assert.match(result.output, /notification channels/);
  }
  const unset = runAlertingGuard({ CORVIS_ENVIRONMENT: "prod", TF_VAR_api_image: image });
  assert.notEqual(unset.status, 0);
});

test("prod runtime deploy passes with at least one channel", () => {
  const result = runAlertingGuard({
    CORVIS_ENVIRONMENT: "prod",
    TF_VAR_api_image: image,
    TF_VAR_monitoring_notification_channel_ids: '["projects/p/notificationChannels/123"]',
  });
  assert.equal(result.status, 0, result.output);
});

test("alerting guard does not apply to non-prod or to foundation-only prod applies", () => {
  for (const env of [
    { CORVIS_ENVIRONMENT: "uat", TF_VAR_api_image: image, TF_VAR_monitoring_notification_channel_ids: "[]" },
    { CORVIS_ENVIRONMENT: "dev", TF_VAR_api_image: "", TF_VAR_monitoring_notification_channel_ids: "[]" },
    { CORVIS_ENVIRONMENT: "prod", TF_VAR_api_image: "", TF_VAR_monitoring_notification_channel_ids: "[]" },
  ]) {
    const result = runAlertingGuard(env);
    assert.equal(result.status, 0, result.output);
  }
});

function stepBody(name: string): string {
  const start = deployWorkflow.indexOf(`- name: ${name}`);
  assert.ok(start >= 0, name);
  const rest = deployWorkflow.slice(start + 1);
  const next = rest.search(/\n      - (name|uses):/);
  return next < 0 ? rest : rest.slice(0, next);
}

test("terraform deploy wires the guards in the right order", () => {
  const checkout = deployWorkflow.slice(deployWorkflow.indexOf("uses: actions/checkout"), deployWorkflow.indexOf("name: Assert release matches deployment checkout"));
  assert.match(checkout, /uses: actions\/checkout@[0-9a-f]{40} # v7/);
  assert.match(checkout, /fetch-depth: 0/);
  assert.match(checkout, /ref: \$\{\{ inputs\.release_sha != '' && inputs\.release_sha \|\| github\.sha \}\}/);

  const releaseGuardStep = stepBody("Assert release matches deployment checkout");
  assert.match(releaseGuardStep, /if: inputs\.release_sha != ''/);
  assert.match(releaseGuardStep, /assert-release-matches-head\.sh "\$\{RELEASE_SHA\}"/);

  const order = [
    "uses: actions/checkout",
    "assert-release-matches-head.sh",
    "name: Terraform plan",
    "name: Apply versioned Postgres migrations",
    "name: Terraform apply",
  ].map((needle) => deployWorkflow.indexOf(needle));
  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);

  const alerting = stepBody("Require prod alerting channels");
  assert.match(alerting, /if: inputs\.action == 'apply' && inputs\.environment == 'prod' && env\.TF_VAR_api_image != '' && inputs\.rollback_known_good != true/, "a known-good rollback must not be blocked by missing alert channels");
  assert.match(alerting, /assert-prod-alerting\.sh/);
  assert.ok(deployWorkflow.indexOf("assert-prod-alerting.sh") < deployWorkflow.indexOf("name: Terraform plan"));
  assert.ok(deployWorkflow.indexOf("assert-prod-alerting.sh") > deployWorkflow.indexOf("name: Resolve immutable release set"));
});

test("rollback deploys skip every forward-only migration step", () => {
  for (const name of [
    "uses: actions/setup-node",
    "name: Install migration runtime",
    "name: Apply versioned Postgres migrations",
    "name: Upload migration evidence",
  ]) {
    const start = deployWorkflow.indexOf(name);
    assert.ok(start >= 0, name);
    const guard = deployWorkflow.slice(start).match(/\n\s*if: ([^\n]+)/)?.[1] ?? "";
    assert.match(guard, /inputs\.rollback_known_good != true/, name);
    assert.match(guard, /inputs\.environment != 'dev'/, name);
  }
  // The runtime secret check and Terraform apply must still run for rollback.
  assert.doesNotMatch(stepBody("Require enabled Postgres runtime secret"), /rollback_known_good/);
  assert.doesNotMatch(stepBody("Terraform apply"), /rollback_known_good/);
});

test("terraform deploy renders the reviewed plan into the job summary before apply", () => {
  const plan = stepBody("Terraform plan");
  assert.match(plan, /terraform -chdir="\$\{TF_ROOT\}" plan -lock-timeout=5m -out=tfplan/);
  assert.match(plan, /show -no-color tfplan/);
  assert.match(plan, /GITHUB_STEP_SUMMARY/);
  assert.match(plan, /sha256sum/);
  assert.ok(deployWorkflow.indexOf("show -no-color tfplan") < deployWorkflow.indexOf("name: Terraform apply"));
});
