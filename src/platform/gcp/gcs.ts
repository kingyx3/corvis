import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { getServerConfig } from "../config/config.ts";

type TokenResponse = { access_token?: string; expires_in?: number };
export type GcsObject = {
  generation?: string;
  size?: string;
  contentType?: string;
  metadata?: Record<string, string>;
  crc32c?: string;
  md5Hash?: string;
};

type GcsOptions = {
  bucket?: string;
  accessToken?: string;
  /** Overrides GCS_REQUEST_TIMEOUT_MS (tests). */
  requestTimeoutMs?: number;
};

export type JsonWithGeneration<T> = { value: T; generation: string };
/** `ok:false` is an `ifGenerationMatch` precondition failure (HTTP 412): someone else wrote first. */
export type ConditionalPutResult = { ok: true; generation: string } | { ok: false };
export type ObjectPage = { names: string[]; nextPageToken?: string };

/**
 * Control-plane surface the upload lifecycle depends on. Keeping it structural
 * lets the ingestion failure paths be exercised against an in-memory store
 * without a live provider binding.
 */
export interface UploadObjectStore {
  readonly bucket: string;
  createResumableUpload(input: {
    key: string;
    contentType: string;
    sizeBytes: number;
    metadata: Record<string, string>;
    origin?: string;
  }): Promise<string>;
  cancelResumableUpload(uploadUrl: string): Promise<void>;
  putJson(key: string, value: unknown): Promise<void>;
  getJson<T>(key: string): Promise<T | null>;
  getObjectMetadata(key: string): Promise<GcsObject | null>;
  getObjectPrefix(key: string, bytes?: number): Promise<Buffer>;
  /** Streams the object and returns the hex SHA-256 of its bytes, pinned to `generation` when given. */
  getObjectSha256(key: string, generation?: string): Promise<string>;
  deleteObject(key: string): Promise<void>;
  listObjects(prefix: string, limit?: number): Promise<string[]>;
  /**
   * Optional optimistic-concurrency surface. GcsControlClient implements it; a store
   * without it (the in-memory fakes) falls back to unconditional writes.
   * Reads a JSON object together with its GCS generation.
   */
  getJsonWithGeneration?<T>(key: string): Promise<JsonWithGeneration<T> | null>;
  /**
   * Writes JSON only if the object's generation still equals `generation`
   * (`"0"`: only if the object does not exist yet). Resolves `{ok:false}` on a
   * lost race instead of throwing.
   */
  putJsonIfGenerationMatch?(key: string, value: unknown, generation: string): Promise<ConditionalPutResult>;
  /** One page of a prefix listing, resumable with `nextPageToken`. */
  listObjectPage?(prefix: string, options: { limit: number; pageToken?: string }): Promise<ObjectPage>;
}

const CANCEL_TIMEOUT_MS = 10_000;
/** GCS accepts resumable chunks in multiples of 256 KiB (except the last). */
const GCS_UPLOAD_CHUNK_GRANULARITY = 256 * 1024;
/** One in-flight upload chunk: the most memory a streamed write ever holds, whatever the object's size. */
export const GCS_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
/** Upper bound for any control-plane GCS call so a stalled provider cannot pin a request. */
export const GCS_REQUEST_TIMEOUT_MS = 30_000;
/** Whole-object reads (integrity hashing) legitimately outlast a metadata call; still bounded beneath a Cloud Run request. */
export const GCS_HASH_TIMEOUT_MS = 240_000;
const METADATA_TOKEN_TIMEOUT_MS = 5_000;

/**
 * GCS requires `Content-Length: 0` on the resumable-session cancel DELETE.
 * fetch (undici) never sends a Content-Length on a bodiless DELETE, even when
 * the header is set explicitly, so the cancel uses node:https directly. The
 * session URI is self-authorizing; no bearer token is attached.
 */
export function deleteWithZeroContentLength(
  url: string,
  requestImpl: typeof httpsRequest = httpsRequest,
  timeoutMs = CANCEL_TIMEOUT_MS,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = requestImpl(new URL(url), {
      method: "DELETE",
      headers: { "content-length": "0", "cache-control": "no-store" },
      timeout: timeoutMs,
    }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("timeout", () => request.destroy(new Error("GCS resumable upload cancellation timed out")));
    request.on("error", reject);
    request.end();
  });
}

function encodeObjectName(value: string): string {
  return encodeURIComponent(value);
}

export class GcsControlClient implements UploadObjectStore {
  readonly bucket: string;
  private staticToken?: string;
  private cachedToken?: { value: string; expiresAt: number };
  private readonly requestTimeoutMs: number;

  constructor(options: GcsOptions = {}) {
    const config = getServerConfig();
    this.bucket = options.bucket ?? config.objectStoreBucket ?? "";
    this.staticToken = options.accessToken ?? config.gcpAccessToken;
    this.requestTimeoutMs = options.requestTimeoutMs ?? GCS_REQUEST_TIMEOUT_MS;
    if (!this.bucket) throw new Error("GCS production adapter is not configured");
  }

  private async accessToken(): Promise<string> {
    if (this.staticToken) return this.staticToken;
    if (this.cachedToken && this.cachedToken.expiresAt - Date.now() > 60_000) return this.cachedToken.value;

    const response = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" }, cache: "no-store", signal: AbortSignal.timeout(METADATA_TOKEN_TIMEOUT_MS) },
    );
    if (!response.ok) throw new Error(`GCP workload identity token request failed (${response.status})`);
    const body = await response.json() as TokenResponse;
    if (!body.access_token) throw new Error("GCP workload identity did not return an access token");
    this.cachedToken = {
      value: body.access_token,
      expiresAt: Date.now() + Math.max(60, body.expires_in ?? 300) * 1000,
    };
    return body.access_token;
  }

  private async authorizedFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.accessToken();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    return fetch(url, { ...init, headers, cache: "no-store", signal: init.signal ?? AbortSignal.timeout(this.requestTimeoutMs) });
  }

  private metadataUrl(key: string): string {
    return `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeObjectName(key)}`;
  }

  private mediaUrl(key: string): string {
    return `${this.metadataUrl(key)}?alt=media`;
  }

  async createResumableUpload(input: {
    key: string;
    contentType: string;
    /** Omit when the size is not known yet (a streamed write): the final chunk then declares the total. */
    sizeBytes?: number;
    metadata: Record<string, string>;
    origin?: string;
  }): Promise<string> {
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?uploadType=resumable&name=${encodeObjectName(input.key)}`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-upload-content-type": input.contentType,
    };
    if (input.sizeBytes !== undefined) headers["x-upload-content-length"] = String(input.sizeBytes);
    if (input.origin) headers.origin = input.origin;
    const response = await this.authorizedFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: input.key, contentType: input.contentType, metadata: input.metadata }),
    });
    if (!response.ok) throw new Error(`GCS resumable upload initiation failed (${response.status})`);
    const location = response.headers.get("location");
    if (!location) throw new Error("GCS resumable upload initiation returned no session URI");
    return location;
  }

  async cancelResumableUpload(uploadUrl: string, requestImpl?: typeof httpsRequest): Promise<void> {
    const status = await deleteWithZeroContentLength(uploadUrl, requestImpl);
    if (![204, 404, 410, 499].includes(status)) {
      throw new Error(`GCS resumable upload cancellation failed (${status})`);
    }
  }

  async putJson(key: string, value: unknown): Promise<void> {
    await this.putObject(key, Buffer.from(JSON.stringify(value)), "application/json");
  }

  async putJsonIfGenerationMatch(key: string, value: unknown, generation: string): Promise<ConditionalPutResult> {
    if (!/^\d+$/.test(generation)) throw new Error("GCS ifGenerationMatch requires a numeric generation");
    const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o`);
    url.searchParams.set("uploadType", "media");
    url.searchParams.set("name", key);
    url.searchParams.set("ifGenerationMatch", generation);
    url.searchParams.set("fields", "generation");
    const body = Buffer.from(JSON.stringify(value));
    const response = await this.authorizedFetch(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(body.byteLength) },
      body: Uint8Array.from(body).buffer,
    });
    if (response.status === 412) return { ok: false };
    if (!response.ok) throw new Error(`GCS conditional write failed (${response.status})`);
    const written = await response.json() as { generation?: string };
    if (!written.generation) throw new Error("GCS conditional write returned no generation");
    return { ok: true, generation: written.generation };
  }

  async getJsonWithGeneration<T>(key: string): Promise<JsonWithGeneration<T> | null> {
    const response = await this.authorizedFetch(this.mediaUrl(key));
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GCS metadata read failed (${response.status})`);
    // The generation of the bytes actually returned travels with the response, so a concurrent
    // overwrite between a separate metadata call and this read cannot be missed.
    const generation = response.headers.get("x-goog-generation");
    if (!generation) throw new Error("GCS metadata read returned no generation");
    return { value: await response.json() as T, generation };
  }

  async listObjectPage(prefix: string, options: { limit: number; pageToken?: string }): Promise<ObjectPage> {
    const url = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o`);
    url.searchParams.set("prefix", prefix);
    url.searchParams.set("fields", "items/name,nextPageToken");
    url.searchParams.set("maxResults", String(Math.min(1000, Math.max(1, options.limit))));
    if (options.pageToken) url.searchParams.set("pageToken", options.pageToken);
    const response = await this.authorizedFetch(url.toString());
    if (!response.ok) throw new Error(`GCS object listing failed (${response.status})`);
    const body = await response.json() as { items?: { name?: string }[]; nextPageToken?: string };
    const names = (body.items ?? []).flatMap((item) => item.name ? [item.name] : []);
    return { names, ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}) };
  }

  async putObject(
    key: string,
    value: Buffer | Uint8Array,
    contentType: string,
    metadata: Record<string, string> = {},
  ): Promise<void> {
    const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o`);
    url.searchParams.set("uploadType", "media");
    url.searchParams.set("name", key);
    if (Object.keys(metadata).length > 0) {
      throw new Error("GCS media uploads do not support custom metadata; write metadata separately or use resumable upload");
    }
    const body = Uint8Array.from(value).buffer;
    const response = await this.authorizedFetch(url.toString(), {
      method: "POST",
      headers: { "content-type": contentType, "content-length": String(value.byteLength) },
      body,
    });
    if (!response.ok) throw new Error(`GCS object write failed (${response.status})`);
  }

  /**
   * Writes an object from a stream of unknown length through a resumable upload, so memory is bounded by one upload
   * chunk (a multiple of 256 KiB, as GCS requires) however large the object is (#231, F10b #322). Returns the size
   * written. A failed or aborted write cancels the upload session so no partial object is left behind.
   */
  async putObjectStream(key: string, source: AsyncIterable<Uint8Array>, contentType: string, options: { chunkBytes?: number } = {}): Promise<{ sizeBytes: number }> {
    const chunkBytes = options.chunkBytes ?? GCS_UPLOAD_CHUNK_BYTES;
    if (!Number.isInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes % GCS_UPLOAD_CHUNK_GRANULARITY !== 0) throw new Error("GCS upload chunks must be a positive multiple of 256 KiB");
    const session = await this.createResumableUpload({ key, contentType, metadata: {} });
    let offset = 0;
    try {
      let pending: Buffer[] = [];
      let pendingBytes = 0;
      for await (const piece of source) {
        pending.push(Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength));
        pendingBytes += piece.byteLength;
        while (pendingBytes >= chunkBytes) {
          const joined = Buffer.concat(pending, pendingBytes);
          await this.uploadRange(session, offset, joined.subarray(0, chunkBytes), undefined);
          offset += chunkBytes;
          pending = [joined.subarray(chunkBytes)];
          pendingBytes -= chunkBytes;
        }
      }
      const rest = Buffer.concat(pending, pendingBytes);
      await this.uploadRange(session, offset, rest, offset + rest.length);
      return { sizeBytes: offset + rest.length };
    } catch (error) {
      await this.cancelResumableUpload(session).catch(() => undefined);
      throw error;
    }
  }

  /** Sends bytes `offset..` of a resumable session, resending whatever the server reports it did not persist. `total` is set on the last range. */
  private async uploadRange(session: string, offset: number, bytes: Buffer, total: number | undefined): Promise<void> {
    let sent = 0;
    for (;;) {
      const remaining = bytes.subarray(sent);
      const start = offset + sent;
      const range = remaining.length === 0 ? `bytes */${total}` : `bytes ${start}-${start + remaining.length - 1}/${total ?? "*"}`;
      // The session URI is self-authorizing (no bearer token). A 308 is the normal answer to a non-final chunk and carries no Location, so redirects are not followed.
      const response = await fetch(session, {
        method: "PUT", headers: { "content-range": range }, body: remaining.length === 0 ? undefined : remaining as unknown as BodyInit,
        redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 200 || response.status === 201) {
        if (total === undefined) throw new Error("GCS resumable upload finished before the last chunk");
        return;
      }
      if (response.status !== 308) throw new Error(`GCS resumable upload failed (${response.status})`);
      // 308: Range names the last persisted byte (absent when nothing was).
      const persisted = /^bytes=0-(\d+)$/.exec(response.headers.get("range") ?? "");
      const next = persisted ? Number(persisted[1]) + 1 : 0;
      if (next >= offset + bytes.length) {
        if (total !== undefined) throw new Error("GCS resumable upload did not finalize the object");
        return;
      }
      if (next <= start) throw new Error("GCS resumable upload made no progress");
      sent = next - offset;
    }
  }

  async getJson<T>(key: string): Promise<T | null> {
    const response = await this.authorizedFetch(this.mediaUrl(key));
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GCS metadata read failed (${response.status})`);
    return response.json() as Promise<T>;
  }

  /** Streams an object's bytes instead of buffering them (export downloads, #231). */
  async getObjectStream(key: string, generation?: string): Promise<{ body: ReadableStream<Uint8Array>; contentType?: string; contentLength?: string } | null> {
    // An `AbortSignal.timeout` also aborts the response body, which would truncate any download that takes
    // longer than the request timeout. Bound only the wait for response headers; the client's own
    // disconnect (or the platform request limit) bounds the transfer.
    const controller = new AbortController();
    const headerTimer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response: Response;
    try { response = await this.authorizedFetch(`${this.mediaUrl(key)}${generation ? `&generation=${encodeURIComponent(generation)}` : ""}`, { signal: controller.signal }); }
    finally { clearTimeout(headerTimer); }
    if (response.status === 404) { await response.body?.cancel().catch(() => undefined); return null; }
    if (!response.ok || !response.body) { await response.body?.cancel().catch(() => undefined); throw new Error(`GCS object read failed (${response.status})`); }
    return {
      body: response.body,
      contentType: response.headers.get("content-type") ?? undefined,
      contentLength: response.headers.get("content-length") ?? undefined,
    };
  }

  async getObjectMetadata(key: string): Promise<GcsObject | null> {
    const response = await this.authorizedFetch(`${this.metadataUrl(key)}?fields=generation,size,contentType,metadata,crc32c,md5Hash`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GCS object metadata read failed (${response.status})`);
    return response.json() as Promise<GcsObject>;
  }

  async getObjectPrefix(key: string, bytes = 32): Promise<Buffer> {
    const limit = Math.max(1, Math.floor(bytes));
    const response = await this.authorizedFetch(this.mediaUrl(key), {
      headers: { range: `bytes=0-${limit - 1}` },
    });
    if (!response.ok && response.status !== 206) throw new Error(`GCS object validation read failed (${response.status})`);
    if (!response.body) return Buffer.from(await response.arrayBuffer()).subarray(0, limit);
    // A server that ignores Range answers 200 with the whole object: read only as much as asked for
    // and cancel the rest, rather than buffering a multi-gigabyte source document in memory.
    const chunks: Buffer[] = [];
    let received = 0;
    const reader = response.body.getReader();
    try {
      while (received < limit) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value.buffer, value.byteOffset, Math.min(value.byteLength, limit - received));
        chunks.push(chunk);
        received += chunk.length;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return Buffer.concat(chunks, received);
  }

  async getObjectSha256(key: string, generation?: string): Promise<string> {
    const url = generation ? `${this.mediaUrl(key)}&generation=${encodeURIComponent(generation)}` : this.mediaUrl(key);
    const response = await this.authorizedFetch(url, { signal: AbortSignal.timeout(GCS_HASH_TIMEOUT_MS) });
    if (!response.ok || !response.body) throw new Error(`GCS object hash read failed (${response.status})`);
    const hash = createHash("sha256");
    // Streamed so a multi-gigabyte source document is never buffered in memory.
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) hash.update(chunk);
    return hash.digest("hex");
  }

  async listObjects(prefix: string, limit = 1000): Promise<string[]> {
    const names: string[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o`);
      url.searchParams.set("prefix", prefix);
      url.searchParams.set("fields", "items/name,nextPageToken");
      url.searchParams.set("maxResults", String(Math.min(1000, Math.max(1, limit - names.length))));
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const response = await this.authorizedFetch(url.toString());
      if (!response.ok) throw new Error(`GCS object listing failed (${response.status})`);
      const body = await response.json() as { items?: { name?: string }[]; nextPageToken?: string };
      for (const item of body.items ?? []) if (item.name) names.push(item.name);
      pageToken = body.nextPageToken;
    } while (pageToken && names.length < limit);
    return names.slice(0, limit);
  }

  async deleteObject(key: string): Promise<void> {
    const response = await this.authorizedFetch(this.metadataUrl(key), { method: "DELETE" });
    if (!response.ok && response.status !== 404) throw new Error(`GCS object deletion failed (${response.status})`);
  }
}

let singleton: GcsControlClient | undefined;
/** Test-only: drop the shared client so the next `gcs()` reads configuration again. */
export function resetGcsClient(): void { singleton = undefined; }

export function gcs(): GcsControlClient {
  if (!singleton) singleton = new GcsControlClient();
  return singleton;
}
