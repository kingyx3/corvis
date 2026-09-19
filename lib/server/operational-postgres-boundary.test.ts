import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const operationalFiles = [
  "lib/server/platform.ts",
  "lib/server/operations.ts",
  "lib/server/research.ts",
  "lib/server/uploads.ts",
  "lib/server/delivery.ts",
  "app/api/v1/admin/control-evidence/route.ts",
  "app/api/v1/admin/deletion-requests/route.ts",
  "app/api/v1/jobs/[jobId]/retry/route.ts",
  "app/api/v1/source-references/[sourceReferenceId]/route.ts",
];

test("operational application paths do not directly depend on Snowflake", async () => {
  for (const path of operationalFiles) {
    const source = await readFile(path, "utf8");
    assert.equal(source.includes("server/snowflake"), false, `${path} imports the optional downstream Snowflake adapter`);
    assert.equal(source.includes("PM_SOURCE."), false, `${path} contains legacy Snowflake source SQL`);
    assert.equal(source.includes("PM_CONTROL."), false, `${path} contains legacy Snowflake control SQL`);
    assert.equal(source.includes("PM_SERVING."), false, `${path} contains legacy Snowflake serving SQL`);
  }
});
