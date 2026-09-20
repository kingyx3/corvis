import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Durable key/value state the control loop reads and writes between runs:
 * the watermark and the single-writer lock. Abstracted behind a port so
 * orchestration logic is testable without touching the filesystem, and so a
 * future deployment can swap in a different durable store without changing
 * the orchestrator.
 */
export interface StateStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string | null): Promise<void>;
}

/**
 * File-backed default. In GitHub Actions the state directory is restored from
 * and saved to an Actions cache entry; it is deliberately not committed back
 * to the protected source branch. Cache loss/eviction is safe: a missing
 * watermark degrades to a full scan and a missing lock simply means no prior
 * runner still owns the application-level lock.
 */
export class FileStateStore implements StateStore {
  private readonly root: string;
  constructor(root = "control-loop/state") { this.root = root; }

  private path(key: string): string {
    if (!/^[a-z0-9_-]+$/i.test(key)) throw new Error(`invalid_state_key:${key}`);
    return `${this.root}/${key}.json`;
  }

  async read(key: string): Promise<string | null> {
    try { return await readFile(this.path(key), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }

  async write(key: string, value: string | null): Promise<void> {
    const path = this.path(key);
    if (value === null) {
      await rm(path, { force: true });
      return;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value, "utf8");
  }
}

export class InMemoryStateStore implements StateStore {
  private readonly values = new Map<string, string>();
  async read(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async write(key: string, value: string | null): Promise<void> {
    if (value === null) this.values.delete(key);
    else this.values.set(key, value);
  }
}
