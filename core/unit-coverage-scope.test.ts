import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const COVERAGE_ROOTS = ["core", "lib", "control-loop", "adapters/upload"];
const TEST_ROOTS = ["core", "lib", "lib/server", "control-loop", "adapters/upload"];
const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*["']([^"']+)["']/g;

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(path.join(ROOT, directory), { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(relative);
    return entry.isFile() && SOURCE_EXTENSION.test(entry.name) ? [path.normalize(relative)] : [];
  }));
  return nested.flat();
}

function isCoverageSource(file: string): boolean {
  return COVERAGE_ROOTS.some((root) => file === root || file.startsWith(`${path.normalize(root)}${path.sep}`)) && !TEST_FILE.test(file);
}

async function resolveRelativeImport(fromFile: string, specifier: string, candidates: Set<string>): Promise<string | null> {
  if (!specifier.startsWith(".")) return null;
  const base = path.normalize(path.join(path.dirname(fromFile), specifier));
  const options = SOURCE_EXTENSION.test(base)
    ? [base]
    : [`${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.cts`, path.join(base, "index.ts"), path.join(base, "index.tsx")];
  return options.find((candidate) => candidates.has(candidate)) ?? null;
}

async function importsFor(file: string, candidates: Set<string>): Promise<string[]> {
  const source = await readFile(path.join(ROOT, file), "utf8");
  const imports: string[] = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const resolved = await resolveRelativeImport(file, match[1], candidates);
    if (resolved) imports.push(resolved);
  }
  return imports;
}

test("every unit-coverage source is reachable from the executed test graph", async () => {
  const allFiles = new Set((await Promise.all(COVERAGE_ROOTS.map(filesUnder))).flat());
  const production = [...allFiles].filter(isCoverageSource).sort();
  const seeds = (await Promise.all(TEST_ROOTS.map(async (root) => {
    const entries = await readdir(path.join(ROOT, root), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && TEST_FILE.test(entry.name))
      .map((entry) => path.normalize(path.join(root, entry.name)));
  }))).flat();

  const reachable = new Set<string>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (reachable.has(file)) continue;
    reachable.add(file);
    for (const imported of await importsFor(file, allFiles)) {
      if (!reachable.has(imported)) queue.push(imported);
    }
  }

  const uncoveredByTestGraph = production.filter((file) => !reachable.has(file));
  assert.deepEqual(
    uncoveredByTestGraph,
    [],
    `Production modules are outside the executed unit-test graph and would be invisible to native coverage: ${uncoveredByTestGraph.join(", ")}`,
  );
});
