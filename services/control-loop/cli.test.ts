import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStateStore, isInvokedDirectly, maybeRunAsCli, parseCliArgs, reportCliFailure, runCli } from "./cli.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** True only when `url`'s host is (a subdomain of) storage.googleapis.com, not merely a URL containing that text anywhere. */
function isGcsUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return hostname === "storage.googleapis.com" || hostname.endsWith(".storage.googleapis.com");
  } catch {
    return false;
  }
}

/** A fetchImpl that answers every GitHub issues-list and GCS/metadata call cli.ts's own adapters can make. */
function stubFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("http://metadata.google.internal/")) {
      return jsonResponse({ access_token: "meta-token", expires_in: 3600 });
    }
    if (isGcsUrl(url)) {
      if (init?.method === "DELETE") return new Response("", { status: 404 });
      return new Response("{}", { status: 200, headers: { "x-goog-generation": "7" } });
    }
    if (url.includes("/issues")) return jsonResponse([]);
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

async function tmpRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "control-loop-cli-test-"));
}

test("parseCliArgs applies defaults and parses flags/options", () => {
  const defaults = parseCliArgs([]);
  assert.equal(defaults.mode, undefined);
  assert.equal(defaults.apply, false);
  assert.equal(defaults["apply-issues"], false);
  assert.equal(defaults.evidence, undefined);
  assert.equal(defaults["mutation-budget"], "20");
  assert.equal(defaults["issue-mutation-budget"], "5");
  assert.equal(defaults.root, ".");

  const given = parseCliArgs(["--mode", "daily", "--apply", "--apply-issues", "--evidence", "out.json", "--mutation-budget", "7", "--issue-mutation-budget", "2", "--root", "/tmp/x"]);
  assert.equal(given.mode, "daily");
  assert.equal(given.apply, true);
  assert.equal(given["apply-issues"], true);
  assert.equal(given.evidence, "out.json");
  assert.equal(given["mutation-budget"], "7");
  assert.equal(given["issue-mutation-budget"], "2");
  assert.equal(given.root, "/tmp/x");
});

test("createStateStore returns a non-durable FileStateStore with no bucket configured, a durable GcsStateStore otherwise", () => {
  const file = createStateStore({ NODE_ENV: "test" }, "/tmp/root");
  assert.equal(file.durable, false);
  assert.equal(file.store.constructor.name, "FileStateStore");

  const gcs = createStateStore({ NODE_ENV: "test", CONTROL_LOOP_STATE_BUCKET: "corvis-control-state.example" }, "/tmp/root");
  assert.equal(gcs.durable, true);
  assert.equal(gcs.store.constructor.name, "GcsStateStore");

  const prefixed = createStateStore({ NODE_ENV: "test", CONTROL_LOOP_STATE_BUCKET: "corvis-control-state.example", CONTROL_LOOP_STATE_PREFIX: "custom-prefix" }, "/tmp/root");
  assert.equal(prefixed.durable, true);
});

test("runCli falls back to process.argv and process.env when the CLI is invoked with no explicit CliIO", async () => {
  const root = await tmpRoot();
  const originalArgv = process.argv;
  const originalEnv = process.env;
  try {
    process.argv = ["node", "/fake/path/cli.ts", "--mode", "manual", "--root", root];
    process.env = { NODE_ENV: "test" };
    await runCli();
  } finally {
    process.argv = originalArgv;
    process.env = originalEnv;
    await rm(root, { recursive: true, force: true });
  }
});

test("runCli treats a rejected watermark read as having no last-scanned commit", async () => {
  const root = await tmpRoot();
  try {
    await runCli({
      argv: ["--mode", "manual", "--root", root],
      env: { NODE_ENV: "test", CONTROL_LOOP_STATE_BUCKET: "corvis-control-state.example" },
      fetchImpl: ((() => {
        let watermarkReads = 0;
        return (async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          if (url.startsWith("http://metadata.google.internal/")) return jsonResponse({ access_token: "meta-token", expires_in: 3600 });
          if (isGcsUrl(url)) {
            // Only cli.ts's own preliminary watermark read (which tolerates a rejection) fails; the
            // orchestrator's later, unguarded read of the same key must still succeed.
            const isFirstWatermarkGet = url.includes("/watermark.json") && (!init?.method || init.method === "GET") && watermarkReads++ === 0;
            if (isFirstWatermarkGet) return new Response("boom", { status: 500 });
            if (init?.method === "DELETE") return new Response("", { status: 404 });
            return new Response("{}", { status: 200, headers: { "x-goog-generation": "1" } });
          }
          throw new Error(`unexpected fetch in test: ${url}`);
        }) as typeof fetch;
      })()),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runCli sets a nonzero exit code when the report status is failed, such as a scan root that does not exist", async () => {
  const missingRoot = join(tmpdir(), `control-loop-cli-test-missing-${crypto.randomUUID()}`);
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    // A local FileStateStore would silently create `missingRoot` as a side effect of acquiring its
    // lock, masking the missing root; GCS has no such side effect, so the scan genuinely fails.
    await runCli({
      argv: ["--mode", "daily", "--root", missingRoot],
      env: { NODE_ENV: "test", CONTROL_LOOP_STATE_BUCKET: "corvis-control-state.example" },
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("http://metadata.google.internal/")) return jsonResponse({ access_token: "meta-token", expires_in: 3600 });
        if (isGcsUrl(url)) {
          // No lock or watermark exists yet in this fresh bucket.
          if (!init?.method || init.method === "GET") return new Response("", { status: 404 });
          return new Response("{}", { status: 200, headers: { "x-goog-generation": "1" } });
        }
        throw new Error(`unexpected fetch in test: ${url}`);
      }) as typeof fetch,
    });
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test("runCli completes a dry-run scan against an empty root with no GitHub credentials configured", async () => {
  const root = await tmpRoot();
  try {
    await runCli({ argv: ["--mode", "manual", "--root", root], env: { NODE_ENV: "test" } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runCli writes the evidence file when --evidence is given", async () => {
  const root = await tmpRoot();
  const evidencePath = join(root, "evidence.json");
  try {
    await runCli({ argv: ["--mode", "manual", "--root", root, "--evidence", evidencePath], env: { NODE_ENV: "test" } });
    const written = JSON.parse(await readFile(evidencePath, "utf8")) as { status: string };
    assert.ok(written.status);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runCli constructs an issue writer and a file-edit applier only when the matching --apply(-issues) flag and a token are both present", async () => {
  const root = await tmpRoot();
  try {
    await runCli({
      argv: ["--mode", "manual", "--root", root, "--apply", "--apply-issues", "--mutation-budget", "nope", "--issue-mutation-budget", "nope"],
      env: { NODE_ENV: "test", GITHUB_REPOSITORY_OWNER: "o", GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "tok" },
      fetchImpl: stubFetch(),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runCli skips the issue writer and applier when --apply(-issues) is not given, even with a token present", async () => {
  const root = await tmpRoot();
  try {
    await runCli({
      argv: ["--mode", "manual", "--root", root],
      env: { NODE_ENV: "test", GITHUB_REPOSITORY_OWNER: "o", GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "tok" },
      fetchImpl: stubFetch(),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runCli persists the report to a durable GCS state store when CONTROL_LOOP_STATE_BUCKET is configured", async () => {
  const root = await tmpRoot();
  try {
    await runCli({
      argv: ["--mode", "manual", "--root", root],
      env: { NODE_ENV: "test", CONTROL_LOOP_STATE_BUCKET: "corvis-control-state.example" },
      fetchImpl: stubFetch(),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reportCliFailure writes an Error's stack (falling back to its message) or a non-Error's string form to stderr, and fails the process", () => {
  const originalExitCode = process.exitCode;
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const chunks: string[] = [];
  process.stderr.write = ((chunk: string) => { chunks.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    process.exitCode = undefined;
    reportCliFailure(new Error("boom"));
    assert.equal(process.exitCode, 1);
    assert.ok(chunks.join("").includes("boom"));

    chunks.length = 0;
    process.exitCode = undefined;
    const bareError = new Error("bare");
    bareError.stack = undefined;
    reportCliFailure(bareError);
    assert.ok(chunks.join("").includes("bare"));

    chunks.length = 0;
    process.exitCode = undefined;
    reportCliFailure("a plain string failure");
    assert.equal(process.exitCode, 1);
    assert.ok(chunks.join("").includes("a plain string failure"));
  } finally {
    process.stderr.write = originalStderrWrite;
    process.exitCode = originalExitCode;
  }
});

test("isInvokedDirectly compares process.argv[1]'s basename against this module's own URL", () => {
  const originalArgv = process.argv;
  try {
    process.argv = ["node", "/some/other/path/not-this-file.ts"];
    assert.equal(isInvokedDirectly(), false);

    // Only the basename needs to match (`node cli.ts` and `node ./services/.../cli.ts`
    // report different full paths for the same module); any path ending in it does.
    process.argv = ["node", "/fake/path/to/cli.ts"];
    assert.equal(isInvokedDirectly(), true);
  } finally {
    process.argv = originalArgv;
  }
});

test("maybeRunAsCli does nothing when this module was not invoked directly", async () => {
  const originalArgv = process.argv;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  let wrote = false;
  process.stdout.write = (() => { wrote = true; return true; }) as typeof process.stdout.write;
  try {
    process.argv = ["node", "/some/other/path/not-this-file.ts"];
    await maybeRunAsCli();
    assert.equal(wrote, false);
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.argv = originalArgv;
  }
});

test("maybeRunAsCli runs the real CLI (via process.argv/process.env) and reports a thrown error when invoked directly", async () => {
  const originalArgv = process.argv;
  const originalEnv = process.env;
  const originalExitCode = process.exitCode;
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const chunks: string[] = [];
  process.stderr.write = ((chunk: string) => { chunks.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    process.argv = ["node", "/fake/path/to/cli.ts", "--mode", "not-a-real-mode"];
    process.env = { NODE_ENV: "test" };
    process.exitCode = undefined;
    await maybeRunAsCli();
    assert.equal(process.exitCode, 1);
    assert.ok(chunks.join("").includes("--mode must be one of"));
  } finally {
    process.stderr.write = originalStderrWrite;
    process.argv = originalArgv;
    process.env = originalEnv;
    process.exitCode = originalExitCode;
  }
});

test("maybeRunAsCli completes a real successful run when invoked directly", async () => {
  const root = await tmpRoot();
  const originalArgv = process.argv;
  const originalEnv = process.env;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  let wrote = false;
  process.stdout.write = (() => { wrote = true; return true; }) as typeof process.stdout.write;
  try {
    process.argv = ["node", "/fake/path/to/cli.ts", "--mode", "manual", "--root", root];
    process.env = { NODE_ENV: "test" };
    await maybeRunAsCli();
    assert.ok(wrote, "the run should have printed its report to stdout");
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.argv = originalArgv;
    process.env = originalEnv;
    await rm(root, { recursive: true, force: true });
  }
});
