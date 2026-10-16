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

test("Dependabot sends one weekly PR for all version-update ecosystems", () => {
  const source = readFileSync(".github/dependabot.yml", "utf8");

  assert.match(
    source,
    /^multi-ecosystem-groups:\n  weekly-dependencies:\n    schedule:\n      interval: weekly\n/m,
    "one top-level multi-ecosystem schedule is required",
  );
  assert.equal(
    (source.match(/^  [a-z0-9-]+:\n    schedule:/gm) ?? []).length,
    1,
    "do not add another separately scheduled version-update group",
  );

  const blocks = source.split(/^  - package-ecosystem: /m).slice(1);
  const ecosystems = blocks.map((block) => block.split("\n", 1)[0].trim());
  assert.deepEqual(ecosystems, ["npm", "github-actions", "docker", "terraform"]);

  for (const block of blocks) {
    assert.match(block, /^    patterns: \["\*"\]$/m, "include every dependency");
    assert.match(block, /^    multi-ecosystem-group: weekly-dependencies$/m);
    assert.match(block, /^    open-pull-requests-limit: \d+$/m);
    assert.doesNotMatch(block, /^    schedule:/m, "schedule comes only from the batch");
    assert.doesNotMatch(block, /^    groups:/m, "no additional per-ecosystem version PRs");
    assert.doesNotMatch(block, /^    ignore:/m, "major upgrades must not be excluded");
  }

  const [npm, actions, docker, terraform] = blocks;
  assert.match(npm, /directories:\n\s+- \/\n\s+- \/tools\/convex-conformance\n/);
  assert.match(actions, /^    directory: \/$/m);
  assert.match(docker, /directories:\n\s+- \/\n\s+- \/services\/control-loop\n\s+- \/services\/extractor\n/);
  assert.match(
    terraform,
    /directories:\n\s+- \/infra\/terraform\/environments\/\*\n\s+- \/infra\/terraform\/modules\/\*/,
  );
});
