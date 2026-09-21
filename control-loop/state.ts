import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Durable key/value state the control loop reads and writes between runs. */
export interface StateStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string | null): Promise<void>;
}

export type VersionedState = { value: string; version: string };

/**
 * Stores used by concurrently invokable runtimes should expose generation-aware
 * compare-and-set. The control-loop lease uses this to prevent two Cloud Run Job
 * executions from both believing they acquired the single-writer lock.
 */
export interface ConditionalStateStore extends StateStore {
  readVersioned(key: string): Promise<VersionedState | null>;
  writeIfVersion(key: string, value: string | null, expectedVersion: string | null): Promise<boolean>;
}

export function isConditionalStateStore(store: StateStore): store is ConditionalStateStore {
  const candidate = store as Partial<ConditionalStateStore>;
  return typeof candidate.readVersioned === "function" && typeof candidate.writeIfVersion === "function";
}

function validateKey(key: string): string {
  if (!/^[a-z0-9_-]+$/i.test(key)) throw new Error(`invalid_state_key:${key}`);
  return key;
}

/**
 * File-backed default. GitHub Actions restores/saves this directory through an
 * Actions cache. Workflow concurrency is the outer serialization boundary for
 * this adapter; the production Cloud Run Job uses GCS conditional writes below.
 */
export class FileStateStore implements StateStore {
  private readonly root: string;
  constructor(root = "control-loop/state") { this.root = root; }

  private path(key: string): string {
    return `${this.root}/${validateKey(key)}.json`;
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

export class InMemoryStateStore implements ConditionalStateStore {
  private readonly values = new Map<string, VersionedState>();
  private nextVersion = 1;

  async read(key: string): Promise<string | null> { return this.values.get(validateKey(key))?.value ?? null; }

  async readVersioned(key: string): Promise<VersionedState | null> {
    const value = this.values.get(validateKey(key));
    return value ? { ...value } : null;
  }

  async write(key: string, value: string | null): Promise<void> {
    const validKey = validateKey(key);
    if (value === null) this.values.delete(validKey);
    else this.values.set(validKey, { value, version: String(this.nextVersion++) });
  }

  async writeIfVersion(key: string, value: string | null, expectedVersion: string | null): Promise<boolean> {
    const validKey = validateKey(key);
    const current = this.values.get(validKey) ?? null;
    if (expectedVersion === null ? current !== null : current?.version !== expectedVersion) return false;
    if (value === null) this.values.delete(validKey);
    else this.values.set(validKey, { value, version: String(this.nextVersion++) });
    return true;
  }
}

type FetchLike = typeof fetch;
type TokenProvider = () => Promise<string>;

/**
 * GCS-backed production state. Every object lives under a fixed prefix, public
 * access is never used, and lock compare-and-set is enforced with Cloud Storage
 * object-generation preconditions (`x-goog-if-generation-match`).
 */
export class GcsStateStore implements ConditionalStateStore {
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly fetchImpl: FetchLike;
  private readonly tokenProvider: TokenProvider;
  private cachedToken: { value: string; expiresAt: number } | null = null;

  constructor(options: { bucket: string; prefix?: string; fetchImpl?: FetchLike; tokenProvider?: TokenProvider }) {
    if (!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(options.bucket)) throw new Error("invalid_gcs_state_bucket");
    this.bucket = options.bucket;
    this.prefix = (options.prefix ?? "control-loop").replace(/^\/+|\/+$/g, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.tokenProvider = options.tokenProvider ?? (() => this.metadataAccessToken());
  }

  private objectName(key: string): string {
    return `${this.prefix}/${validateKey(key)}.json`;
  }

  private objectUrl(key: string): string {
    const encodedPath = this.objectName(key).split("/").map(encodeURIComponent).join("/");
    return `https://${this.bucket}.storage.googleapis.com/${encodedPath}`;
  }

  private async metadataAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt - 60_000 > now) return this.cachedToken.value;
    const response = await this.fetchImpl(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" } },
    );
    if (!response.ok) throw new Error(`gcp_metadata_token_failed:${response.status}`);
    const body = await response.json() as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("gcp_metadata_token_missing");
    this.cachedToken = {
      value: body.access_token,
      expiresAt: now + Math.max(60, body.expires_in ?? 300) * 1000,
    };
    return body.access_token;
  }

  private async authHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.tokenProvider()}`, ...extra };
  }

  async read(key: string): Promise<string | null> {
    return (await this.readVersioned(key))?.value ?? null;
  }

  async readVersioned(key: string): Promise<VersionedState | null> {
    const response = await this.fetchImpl(this.objectUrl(key), { headers: await this.authHeaders() });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`gcs_state_read_failed:${response.status}`);
    const generation = response.headers.get("x-goog-generation");
    if (!generation || !/^\d+$/.test(generation)) throw new Error("gcs_state_generation_missing");
    return { value: await response.text(), version: generation };
  }

  async write(key: string, value: string | null): Promise<void> {
    const url = this.objectUrl(key);
    const response = value === null
      ? await this.fetchImpl(url, { method: "DELETE", headers: await this.authHeaders() })
      : await this.fetchImpl(url, {
          method: "PUT",
          headers: await this.authHeaders({ "Content-Type": "application/json; charset=utf-8" }),
          body: value,
        });
    if (value === null && response.status === 404) return;
    if (!response.ok) throw new Error(`gcs_state_write_failed:${response.status}`);
  }

  async writeIfVersion(key: string, value: string | null, expectedVersion: string | null): Promise<boolean> {
    const url = this.objectUrl(key);
    if (value === null && expectedVersion === null) return true;
    const generation = expectedVersion ?? "0";
    const headers = await this.authHeaders({ "x-goog-if-generation-match": generation });
    const response = value === null
      ? await this.fetchImpl(url, { method: "DELETE", headers })
      : await this.fetchImpl(url, {
          method: "PUT",
          headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
          body: value,
        });
    if (response.status === 404 && value === null) return true;
    if (response.status === 412) return false;
    if (!response.ok) throw new Error(`gcs_state_conditional_write_failed:${response.status}`);
    return true;
  }
}
