import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function yamlFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...yamlFiles(path));
    else if (/\.ya?ml$/i.test(entry.name)) files.push(path);
  }
  return files;
}

test("external GitHub Actions are pinned to immutable commits", () => {
  const roots = [".github/workflows", ".github/actions"];
  const violations: string[] = [];

  for (const root of roots) {
    for (const path of yamlFiles(root)) {
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm)) {
        const target = match[1];
        if (target.startsWith("./")) continue;
        if (target.startsWith("docker://")) {
          if (!/^docker:\/\/[^\s@]+@sha256:[0-9a-f]{64}$/.test(target)) {
            violations.push(`${path}: ${target}`);
          }
          continue;
        }
        if (!/^[^\s@]+\/[^\s@]+@[0-9a-f]{40}$/.test(target)) {
          violations.push(`${path}: ${target}`);
        }
      }
    }
  }

  assert.deepEqual(violations, [], `mutable external action references:\n${violations.join("\n")}`);
});

test("Dependabot uses a single, minimal, documented multi-ecosystem group", () => {
  const source = readFileSync(".github/dependabot.yml", "utf8");
  assert.match(source, /^version: 2\n/m);
  assert.match(source, /^multi-ecosystem-groups:\n  weekly-dependencies:\n    schedule:\n      interval: "weekly"\n/m);
  assert.equal((source.match(/^      interval:/gm) ?? []).length, 1);

  const blocks = source.split(/^  - package-ecosystem: /m).slice(1);
  assert.deepEqual(blocks.map((block) => block.split("\n", 1)[0].trim()), [
    '"npm"', '"npm"', '"github-actions"', '"docker"', '"docker"', '"docker"', '"terraform"',
  ]);

  for (const block of blocks) {
    assert.match(block, /^    patterns: \["\*"\]$/m);
    assert.match(block, /^    multi-ecosystem-group: "weekly-dependencies"$/m);
    // The native multi-ecosystem group owns the cadence and PR; keeping its
    // entries minimal prevents regressions to unsupported option combinations.
    for (const disallowed of ["schedule", "groups", "ignore", "open-pull-requests-limit"]) {
      assert.doesNotMatch(block, new RegExp("^    " + disallowed + ":", "m"));
    }
  }

  const directory = (block: string) => block.match(/^    directory: "([^"]+)"$/m)?.[1];
  assert.deepEqual(blocks.slice(0, 6).map(directory), [
    "/", "/tools/convex-conformance", "/", "/", "/services/control-loop", "/services/extractor",
  ]);
  assert.match(
    blocks[6],
    /directories:\n      - "\/infra\/terraform\/environments\/\*"\n      - "\/infra\/terraform\/modules\/\*"\n/,
  );
});
