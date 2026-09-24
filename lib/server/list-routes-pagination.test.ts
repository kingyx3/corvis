import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// See lib/server/source-connections-routes.test.ts for why this loader is
// needed: route modules use the Next.js "@/..." path alias.
register(new URL("./test-support/alias-loader.mjs", import.meta.url), import.meta.url);

process.env.CORVIS_DEMO_MODE = "true";

const routes = {
  documents: (await import("@/app/api/v1/documents/route")).GET,
  jobs: (await import("@/app/api/v1/jobs/route")).GET,
  observations: (await import("@/app/api/v1/observations/route")).GET,
  snapshots: (await import("@/app/api/v1/snapshots/route")).GET,
};

function request(path: string): Request {
  return new Request(`https://corvis.test${path}`, {
    headers: {
      "x-corvis-demo-tenant": "tenant-list-routes",
      "x-corvis-demo-workspace": "workspace-1",
      "x-corvis-demo-subject": "demo-user",
      "x-corvis-demo-roles": "admin",
    },
  });
}

type ListBody = { data: Array<Record<string, unknown>>; nextCursor: string | null };

test("list routes answer 400 for a malformed cursor or limit now that the cursor is decoded before the SQL keyset fetch", async () => {
  for (const [name, get] of Object.entries(routes)) {
    for (const query of ["cursor=not-a-cursor", `cursor=${Buffer.from(JSON.stringify({ v: 1, k: "" })).toString("base64url")}`, "limit=0"]) {
      const response = await get(request(`/api/v1/${name}?${query}`));
      assert.equal(response.status, 400, `${name}?${query}`);
      assert.equal((await response.json() as { error: string }).error, "invalid_cursor");
    }
  }
});

test("list routes still walk the demo platform (which ignores the keyset page) exactly once per item", async () => {
  for (const [name, get] of Object.entries(routes)) {
    const unpaged = await (await get(request(`/api/v1/${name}`))).json() as ListBody;
    assert.equal(unpaged.nextCursor, null);
    const seen: unknown[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `limit=1&cursor=${cursor}` : "limit=1";
      const response = await get(request(`/api/v1/${name}?${query}`));
      assert.equal(response.status, 200, name);
      const body = await response.json() as ListBody;
      assert.ok(body.data.length <= 1);
      seen.push(...body.data);
      cursor = body.nextCursor;
    } while (cursor);
    assert.equal(seen.length, unpaged.data.length, name);
    assert.deepEqual(
      new Set(seen.map((item) => JSON.stringify(item))),
      new Set(unpaged.data.map((item) => JSON.stringify(item))),
      name,
    );
  }
});
