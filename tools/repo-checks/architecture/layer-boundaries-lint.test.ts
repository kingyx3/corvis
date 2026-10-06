import assert from "node:assert/strict";
import test from "node:test";
import { ESLint } from "eslint";
import { matchesPrefix, resolveImport } from "../../eslint/layer-boundaries.mjs";

// The layer rules live in eslint.config.mjs and run in `npm run lint`. These tests prove the configuration fires
// on the violations it exists to stop (and stays quiet on the imports the layering allows), so a refactor of the
// config cannot silently turn the guard off.

const eslint = new ESLint({ cwd: process.cwd() });

async function messages(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  assert.ok(result, "expected a lint result");
  return result.messages.filter((message) => message.ruleId === "corvis/layer-boundaries" || message.ruleId === "no-restricted-imports").map((message) => message.message);
}

test("matchesPrefix treats * as exactly one path segment and matches whole segments only", () => {
  assert.equal(matchesPrefix("src/modules/review/ui/view.tsx", "src/modules/*/ui/"), true);
  assert.equal(matchesPrefix("src/modules/review/ui", "src/modules/*/ui/"), true);
  assert.equal(matchesPrefix("src/modules/review/uix/view.tsx", "src/modules/*/ui/"), false);
  assert.equal(matchesPrefix("src/modules/a/b/ui/view.tsx", "src/modules/*/ui/"), false);
  assert.equal(matchesPrefix("src/platformer/x.ts", "src/platform/"), false);
});

test("resolveImport follows the @/ alias and relative paths and ignores packages", () => {
  assert.equal(resolveImport("src/modules/review/ui/view.tsx", "@/platform/http/http.ts"), "src/platform/http/http.ts");
  assert.equal(resolveImport("src/modules/review/ui/view.tsx", "../server/review.ts"), "src/modules/review/server/review.ts");
  assert.equal(resolveImport("src/modules/review/ui/a/view.tsx", "../../../delivery/adapters/x"), "src/modules/delivery/adapters/x");
  assert.equal(resolveImport("src/modules/review/ui/view.tsx", "react"), null);
});

test("domain code cannot import server, adapter, UI, platform or composition code", async () => {
  for (const specifier of ["../server/review.ts", "../adapters/store.ts", "../ui/view.tsx", "@/platform/http/http.ts", "@/composition/services.ts"]) {
    assert.equal((await messages("src/modules/review/domain/rule.ts", `import { x } from "${specifier}";\nexport const y = x;\n`)).length, 1, specifier);
  }
  assert.equal((await messages("src/shared/domain/kernel.ts", `import { x } from "@/platform/http/http.ts";\nexport const y = x;\n`)).length, 1);
});

test("UI and client-side application code cannot reach server, adapters or platform, or import Node-only packages", async () => {
  for (const specifier of ["@/modules/review/server/review.ts", "../../delivery/adapters/store.ts", "@/platform/http/http.ts"]) {
    assert.equal((await messages("src/modules/review/ui/view.tsx", `import { x } from "${specifier}";\nexport const y = x;\n`)).length, 1, specifier);
  }
  assert.equal((await messages("src/modules/sources/application/use-case.ts", `import { x } from "@/platform/http/http.ts";\nexport const y = x;\n`)).length, 1);
  assert.equal((await messages("src/shared/ui/widget.tsx", `import { readFileSync } from "node:fs";\nexport const y = readFileSync;\n`)).length, 1);
  assert.equal((await messages("src/modules/review/ui/view.tsx", `import pg from "pg";\nexport const y = pg;\n`)).length, 1);
  assert.equal((await messages("src/modules/review/ui/view.tsx", `import { NextResponse } from "next/server";\nexport const y = NextResponse;\n`)).length, 1);
});

test("dynamic imports, require calls and re-exports are checked like static imports", async () => {
  assert.equal((await messages("src/modules/review/ui/view.tsx", `export const load = () => import("@/platform/http/http.ts");\n`)).length, 1);
  assert.equal((await messages("src/modules/review/ui/view.tsx", `export { x } from "@/platform/http/http.ts";\n`)).length, 1);
  assert.equal((await messages("src/modules/review/ui/view.tsx", `export * from "@/platform/http/http.ts";\n`)).length, 1);
  assert.equal((await messages("src/modules/review/domain/rule.ts", `const x = require("../server/review.ts");\nexport { x };\n`)).length, 1);
});

test("server and adapter code cannot import UI or composition, and a module's adapters stay internal", async () => {
  assert.equal((await messages("src/modules/review/server/review.ts", `import { x } from "../ui/view.tsx";\nexport const y = x;\n`)).length, 1);
  assert.equal((await messages("src/modules/review/adapters/store.ts", `import { x } from "@/composition/services.ts";\nexport const y = x;\n`)).length, 1);
  assert.equal((await messages("src/modules/review/server/review.ts", `import { x } from "../../delivery/adapters/tenant-export-store.ts";\nexport const y = x;\n`)).length, 1);
  assert.equal((await messages("src/app/page.tsx", `import { x } from "@/modules/delivery/adapters/tenant-export-store.ts";\nexport const y = x;\n`)).length, 1);
});

test("src/platform cannot import module runtime layers, only module domain types", async () => {
  for (const specifier of ["@/modules/review/server/review.ts", "@/modules/workspace/adapters/company-sector-store.ts", "@/modules/workspace/ui/preferences/preference-provider.tsx", "@/modules/sources/application/upload-document.ts"]) {
    assert.equal((await messages("src/platform/http/api/http.ts", `import { x } from "${specifier}";\nexport const y = x;\n`)).length, 1, specifier);
  }
});

test("production code cannot import test support", async () => {
  for (const file of ["src/modules/review/server/review.ts", "src/platform/http/http.ts", "src/app/page.tsx", "src/shared/lib/format.ts"]) {
    assert.equal((await messages(file, `import { x } from "@/test-support/identity-assertion.ts";\nexport const y = x;\n`)).length, 1, file);
  }
});

test("the imports the layering allows are not flagged", async () => {
  const allowed: Array<[string, string]> = [
    ["src/modules/review/ui/view.tsx", "@/modules/review/domain/review-decision.ts"],
    ["src/modules/review/ui/view.tsx", "@/composition/services.ts"],
    ["src/modules/review/ui/view.tsx", "@/shared/ui/modal.tsx"],
    ["src/modules/review/server/review.ts", "@/platform/http/http.ts"],
    ["src/modules/review/server/review.ts", "../../identity-access/server/authorization.ts"],
    ["src/modules/review/server/review.ts", "../adapters/store.ts"],
    ["src/modules/review/domain/rule.ts", "@/shared/domain/contracts.ts"],
    ["src/shared/lib/display-format.ts", "../../modules/workspace/domain/display-preferences.ts"],
    ["src/composition/services.ts", "@/modules/workspace/adapters/http-workspace.ts"],
    ["src/platform/data/platform.ts", "../../modules/workspace/domain/workspace-summary.ts"],
    ["src/platform/demo/catalog.ts", "@/modules/workspace/domain/sector-taxonomy.ts"],
    ["src/modules/workspace/adapters/demo-workspace.ts", "@/platform/demo/company-sector-store.ts"],
    ["src/modules/review/adapters/store.ts", "../domain/review-decision.ts"],
  ];
  for (const [file, specifier] of allowed) {
    assert.deepEqual(await messages(file, `import { x } from "${specifier}";\nexport const y = x;\n`), [], `${file} -> ${specifier}`);
  }
});

test("tests are exempt from the layering rules", async () => {
  assert.deepEqual(await messages("src/modules/review/ui/view.test.tsx", `import { x } from "@/modules/review/server/review.ts";\nexport const y = x;\n`), []);
});
