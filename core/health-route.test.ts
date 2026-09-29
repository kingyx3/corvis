import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

// Route handlers import through the "@/" tsconfig alias, which plain Node does
// not resolve. Map it to the repo root for this test process only.
const root = process.cwd();
const hook = `
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const root = ${JSON.stringify(root)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const base = join(root, specifier.slice(2));
    for (const candidate of [base + ".ts", join(base, "index.ts")]) {
      if (existsSync(candidate)) return nextResolve(pathToFileURL(candidate).href, context);
    }
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);

const routePath = join(root, "app/api/v1/health/route.ts");

test("health route exists on disk", () => {
  assert.ok(existsSync(routePath));
});

test("health responds 200 with only liveness fields and no-store headers", async () => {
  const previous = { sha: process.env.GITHUB_SHA, vercel: process.env.VERCEL_GIT_COMMIT_SHA };
  process.env.GITHUB_SHA = "0123456789abcdef0123456789abcdef01234567";
  process.env.VERCEL_GIT_COMMIT_SHA = "fedcba9876543210fedcba9876543210fedcba98";
  try {
    const { GET } = (await import(pathToFileURL(routePath).href)) as { GET: () => Promise<Response> };
    const response = await GET();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");

    const raw = await response.text();
    const body = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(body.status, "ok");
    assert.deepEqual(Object.keys(body).sort(), ["service", "status"]);
    assert.doesNotMatch(raw, /0123456789abcdef|fedcba9876543210/);
    assert.equal("version" in body, false);
    assert.equal("time" in body, false);
  } finally {
    if (previous.sha === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = previous.sha;
    if (previous.vercel === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
    else process.env.VERCEL_GIT_COMMIT_SHA = previous.vercel;
  }
});
