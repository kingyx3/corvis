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

test("Dependabot covers every dependency ecosystem the repository ships", () => {
  const source = readFileSync(".github/dependabot.yml", "utf8");
  const blocks = source.split(/^  - package-ecosystem: /m).slice(1);
  const byEcosystem = new Map(blocks.map((block) => [block.split("\n", 1)[0].trim(), block]));

  for (const ecosystem of ["npm", "github-actions", "docker", "terraform"]) {
    const block = byEcosystem.get(ecosystem);
    assert.ok(block, `${ecosystem} ecosystem must be configured`);
    assert.match(block, /interval: weekly/, ecosystem);
    assert.match(block, /open-pull-requests-limit: \d+/, ecosystem);
  }

  const docker = byEcosystem.get("docker")!;
  assert.match(docker, /directories:\n\s+- \/\n\s+- \/services\/control-loop\n\s+- \/services\/extractor\n/);
  assert.match(docker, /groups:\n\s+docker-base-images:\n\s+patterns:\n\s+- "\*"/);

  const terraform = byEcosystem.get("terraform")!;
  assert.match(terraform, /directories:\n\s+- \/infra\/terraform\/environments\/\*\n\s+- \/infra\/terraform\/modules\/\*/);
  assert.match(terraform, /groups:\n\s+terraform-providers:\n\s+patterns:\n\s+- "\*"/);
});
