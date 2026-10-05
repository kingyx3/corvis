import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

// Executable form of the layout described in docs/architecture/ARCHITECTURE.md. A new top-level
// directory, a module with an unknown layer, or an unindexed document is a deliberate decision, so it
// fails here until the layout (and its documentation) is updated on purpose.

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 1 << 28 }).split("\0").filter(Boolean);

function children(prefix: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of tracked) {
    if (!file.startsWith(prefix)) continue;
    const [head, ...rest] = file.slice(prefix.length).split("/");
    if (!head) continue;
    found.set(head, [...(found.get(head) ?? []), rest.join("/")]);
  }
  return found;
}

const isFile = (entries: string[]) => entries.every((entry) => entry === "");

test("the repository root holds only known files and directories", () => {
  const allowed = new Set([
    ".dockerignore", ".editorconfig", ".env.example", ".gitattributes", ".github", ".gitignore", ".gitleaksignore", ".nvmrc",
    "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "Dockerfile", "README.md", "SECURITY.md",
    "db", "docs", "e2e", "eslint.config.mjs", "infra", "next.config.ts", "openapi", "ops",
    "package-lock.json", "package.json", "playwright.config.ts", "services", "src", "tools", "tsconfig.json",
  ]);
  const unexpected = [...children("").keys()].filter((name) => !allowed.has(name));
  assert.deepEqual(unexpected, [], "add new top-level entries to this list and to docs/architecture/ARCHITECTURE.md on purpose");
});

test("src holds only the documented top-level areas", () => {
  const areas = children("src/");
  const directories = new Set(["app", "composition", "modules", "platform", "shared", "test-support"]);
  const files = new Set(["instrumentation-client.ts", "proxy.ts"]);
  const unexpected = [...areas].filter(([name, entries]) => (isFile(entries) ? !files.has(name) : !directories.has(name))).map(([name]) => name);
  assert.deepEqual(unexpected, []);
  for (const name of directories) assert.ok(areas.has(name), `src/${name}/ is documented but missing`);
});

test("every module is made only of the documented layers", () => {
  const layers = new Set(["adapters", "application", "domain", "server", "ui"]);
  const modules = children("src/modules/");
  modules.delete("README.md");
  assert.ok(modules.size >= 10, "expected the bounded modules under src/modules/");
  for (const [name, entries] of modules) {
    assert.ok(!isFile(entries), `src/modules/${name} must be a directory`);
    const found = new Set(entries.map((entry) => entry.split("/")[0]!));
    for (const layer of found) assert.ok(layers.has(layer), `src/modules/${name}/${layer} is not one of ${[...layers].join(", ")}`);
  }
});

test("src/platform and src/shared are organised in folders, with no loose files", () => {
  for (const area of ["src/platform/", "src/shared/"]) {
    const loose = [...children(area)].filter(([, entries]) => isFile(entries)).map(([name]) => `${area}${name}`);
    assert.deepEqual(loose, []);
  }
});

test("documents live in a topic folder and every one is listed in the docs index", () => {
  const topics = new Set(["architecture", "engineering", "features", "operations", "reviews", "security"]);
  const docs = tracked.filter((file) => file.startsWith("docs/") && file !== "docs/README.md");
  const index = readFileSync("docs/README.md", "utf8");
  for (const doc of docs) {
    const [, topic, ...rest] = doc.split("/");
    assert.ok(topic && rest.length === 1 && topics.has(topic), `${doc} must sit directly in one of docs/{${[...topics].join(",")}}/`);
    assert.ok(index.includes(`(./${path.posix.relative("docs", doc)})`), `${doc} is not listed in docs/README.md`);
  }
});

test("the legacy top-level application directories do not come back", () => {
  const present = tracked.filter((file) => /^(?:app|components|features|lib|core|adapters|runtime|application|scripts)\//.test(file));
  assert.deepEqual(present.slice(0, 5), []);
});

test("no directory in the code areas grows past the size a reader can scan", () => {
  const LIMIT = 35;
  const sizes = new Map<string, number>();
  for (const file of tracked) {
    if (!/^(?:src|tools|services|e2e)\//.test(file)) continue;
    const directory = file.slice(0, file.lastIndexOf("/"));
    sizes.set(directory, (sizes.get(directory) ?? 0) + 1);
  }
  const oversized = [...sizes].filter(([, count]) => count > LIMIT).map(([directory, count]) => `${directory} (${count} files)`);
  assert.deepEqual(oversized, [], `group the files into feature folders; limit is ${LIMIT} files per directory (tests included)`);
});
