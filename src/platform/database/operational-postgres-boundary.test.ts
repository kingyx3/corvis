import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const operationalFiles = [
  "src/platform/data/platform.ts",
  "src/modules/governance/server/operations/operations.ts",
  "src/modules/research/server/research.ts",
  "src/modules/sources/server/uploads/uploads.ts",
  "src/modules/delivery/server/exports/delivery.ts",
  "src/app/api/v1/admin/control-evidence/route.ts",
  "src/app/api/v1/admin/deletion-requests/route.ts",
  "src/app/api/v1/jobs/[jobId]/retry/route.ts",
  "src/app/api/v1/source-references/[sourceReferenceId]/route.ts",
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
