import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseYaml } from "./test-support/openapi-support.ts";

test("the test YAML parser rejects a key repeated inside a flow mapping", () => {
  assert.throws(() => parseYaml("a: { b: 1, b: 2 }\n"), /duplicate key b/);
  assert.deepEqual(parseYaml("a: { b: 1, c: 2 }\n"), { a: { b: 1, c: 2 } });
});

test("the OpenAPI contract has no repeated mapping keys", async () => {
  const source = await readFile(new URL("../../openapi/corvis-v1.yaml", import.meta.url), "utf8");
  assert.doesNotThrow(() => parseYaml(source));
});
