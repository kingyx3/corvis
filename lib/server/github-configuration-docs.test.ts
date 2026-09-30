import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

// Every GitHub Actions variable and secret a workflow reads must be in the complete reference table of
// docs/GITHUB_ENVIRONMENTS.md, so operators never discover a required setting from a failed run.
test("every workflow variable and secret is documented in docs/GITHUB_ENVIRONMENTS.md", async () => {
  const sources: string[] = [];
  for (const dir of [".github/workflows", ".github/actions/setup-terraform-cached"]) {
    for (const entry of await readdir(dir)) if (/\.ya?ml$/.test(entry)) sources.push(await readFile(`${dir}/${entry}`, "utf8"));
  }
  const referenced = new Set(sources.flatMap((source) => [...source.matchAll(/\b(?:vars|secrets)\.([A-Z0-9_]+)/g)].map((match) => match[1]!)));
  assert.ok(referenced.has("GCP_PROJECT_ID") && referenced.has("RELEASE_GOVERNANCE_TOKEN"), "discovery must find the workflow configuration");

  const doc = await readFile("docs/GITHUB_ENVIRONMENTS.md", "utf8");
  const reference = doc.slice(doc.indexOf("## Complete reference"), doc.indexOf("## Required environment variables"));
  const documented = new Set([...reference.matchAll(/^\| `([A-Z0-9_]+)` \|/gm)].map((match) => match[1]!));
  assert.deepEqual([...referenced].filter((name) => !documented.has(name)).sort(), [], "add these to the Complete reference table");
  assert.deepEqual([...documented].filter((name) => !referenced.has(name)).sort(), [], "the table lists settings no workflow reads any more");
});
