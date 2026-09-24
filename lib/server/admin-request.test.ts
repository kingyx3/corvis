import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { readJsonObject } from "./admin-request.ts";

function post(body: string): Request {
  return new Request("https://corvis.test/api/v1/admin/x", { method: "POST", headers: { "content-type": "application/json" }, body });
}

test("readJsonObject accepts only a JSON object command body", async () => {
  assert.deepEqual(await readJsonObject(post(JSON.stringify({ key: "ui.delivery_workspace" }))), { key: "ui.delivery_workspace" });
  for (const body of ["null", "[]", "[{\"key\":\"x\"}]", "42", "\"text\"", "true", "{not json", ""]) {
    assert.equal(await readJsonObject(post(body)), undefined, `body ${JSON.stringify(body)} must be rejected`);
  }
});

async function routeFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await routeFiles(full));
    else if (entry.name === "route.ts") found.push(full.replaceAll("\\", "/"));
  }
  return found;
}

test("every admin command route rejects a null/array/primitive body with 400 before reading fields", async () => {
  const files = (await routeFiles("app/api/v1/admin")).filter((file) => !file.includes("/admin/webhooks/"));
  let commandRoutes = 0;
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.equal(/request\.json\(\)/.test(source), false, `${file} must read its body through readJsonObject`);
    if (!source.includes("readJsonObject(request)")) continue;
    commandRoutes += 1;
    assert.match(source, /if \(!body\) return json\(\{ error: "invalid_request", correlationId: id \}, \{ status: 400 \}\);/, file);
  }
  assert.ok(commandRoutes >= 10, `expected every admin command route to be guarded, saw ${commandRoutes}`);
});
