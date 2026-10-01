import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const COVERAGE_ROOTS = ["core", "lib", "control-loop", "adapters/upload"];
const GRAPH_ROOTS = ["app", "components", "features", "runtime", "adapters", "core", "lib", "control-loop"];
const TEST_ROOTS = ["core", "lib", "lib/server", "control-loop", "adapters/upload"];
const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*["']([^"']+)["']/g;

async function filesUnder(directory: string): Promise<string[]> {
  const absolute = path.join(ROOT, directory);
  let entries;
  try { entries = await readdir(absolute, { withFileTypes: true }); }
  catch { return []; }
  const nested = await Promise.all(entries.map(async (entry) => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(relative);
    return entry.isFile() && SOURCE_EXTENSION.test(entry.name) ? [path.normalize(relative)] : [];
  }));
  return nested.flat();
}

function isCoverageSource(file: string): boolean {
  return COVERAGE_ROOTS.some((root) => file === root || file.startsWith(`${path.normalize(root)}${path.sep}`))
    && !TEST_FILE.test(file)
    && !file.includes(`${path.sep}test-support${path.sep}`);
}

function importBase(fromFile: string, specifier: string): string | null {
  if (specifier.startsWith("@/")) return path.normalize(specifier.slice(2));
  if (specifier.startsWith(".")) return path.normalize(path.join(path.dirname(fromFile), specifier));
  return null;
}

function resolveImport(fromFile: string, specifier: string, candidates: Set<string>): string | null {
  const base = importBase(fromFile, specifier);
  if (!base) return null;
  const options = SOURCE_EXTENSION.test(base)
    ? [base]
    : [`${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.cts`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`, path.join(base, "index.ts"), path.join(base, "index.tsx")];
  return options.find((candidate) => candidates.has(candidate)) ?? null;
}

async function importsFor(file: string, candidates: Set<string>): Promise<string[]> {
  const source = await readFile(path.join(ROOT, file), "utf8");
  const imports: string[] = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const resolved = resolveImport(file, match[1], candidates);
    if (resolved) imports.push(resolved);
  }
  return imports;
}

test("every unit-coverage source is reachable from the executed test graph", async () => {
  const graphFiles = new Set((await Promise.all(GRAPH_ROOTS.map(filesUnder))).flat());
  const production = [...graphFiles].filter(isCoverageSource).sort();
  const seeds = (await Promise.all(TEST_ROOTS.map(filesUnder))).flat().filter((file) => TEST_FILE.test(file));

  const reachable = new Set<string>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (reachable.has(file)) continue;
    reachable.add(file);
    for (const imported of await importsFor(file, graphFiles)) {
      if (!reachable.has(imported)) queue.push(imported);
    }
  }

  const outsideTestGraph = production.filter((file) => !reachable.has(file));
  assert.deepEqual(
    outsideTestGraph,
    [],
    `Production modules are outside the executed unit-test graph and can disappear from native coverage: ${outsideTestGraph.join(", ")}`,
  );
});
