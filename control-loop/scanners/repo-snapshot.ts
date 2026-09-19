import { readFile, readdir } from "node:fs/promises";
import type { RunMode, Watermark } from "../types.ts";

export interface RepoFile {
  path: string;
  text: string;
}

export interface RepoSnapshot {
  root: string;
  files: RepoFile[];
  paths: Set<string>;
}

const IGNORED_DIRECTORIES = new Set([".git", ".next", "node_modules", "out", "build", "coverage", "test-results", "playwright-report", ".claude"]);
const TEXT_EXTENSIONS = new Set([".md", ".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".yml", ".yaml", ".sql", ".json", ".tf"]);
const MAX_TEXT_BYTES = 512 * 1024;

function extensionOf(path: string): string {
  const index = path.lastIndexOf(".");
  return index === -1 ? "" : path.slice(index).toLowerCase();
}

async function walk(root: string, relative: string, snapshot: RepoSnapshot): Promise<void> {
  const absolute = relative ? `${root}/${relative}` : root;
  const entries = await readdir(absolute, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      snapshot.paths.add(path);
      await walk(root, path, snapshot);
      continue;
    }
    if (!entry.isFile()) continue;
    snapshot.paths.add(path);
    if (!TEXT_EXTENSIONS.has(extensionOf(path))) continue;
    const text = await readFile(`${root}/${path}`, "utf8");
    if (text.length > MAX_TEXT_BYTES) continue;
    snapshot.files.push({ path, text });
  }
}

export async function loadRepoSnapshot(root: string): Promise<RepoSnapshot> {
  const snapshot: RepoSnapshot = { root, files: [], paths: new Set<string>() };
  await walk(root, "", snapshot);
  snapshot.files.sort((left, right) => (left.path < right.path ? -1 : 1));
  return snapshot;
}

export interface ScanScope {
  full: boolean;
  reason: string;
  files: RepoFile[];
}

export function selectScanScope(input: { mode: RunMode; watermark: Watermark; snapshot: RepoSnapshot; changedPaths: string[] | null }): ScanScope {
  const { mode, watermark, snapshot, changedPaths } = input;
  if (mode !== "daily") return { full: true, reason: `${mode}_full_scan_ignores_watermark`, files: snapshot.files };
  if (!watermark.lastSuccessfulDailyRunAt) return { full: true, reason: "no_daily_watermark_full_scan", files: snapshot.files };
  if (changedPaths === null) return { full: true, reason: "changed_paths_unavailable_full_scan", files: snapshot.files };
  const changed = new Set(changedPaths);
  return { full: false, reason: "daily_incremental_since_watermark", files: snapshot.files.filter((file) => changed.has(file.path)) };
}
