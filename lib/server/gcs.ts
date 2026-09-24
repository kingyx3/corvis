import { request as httpsRequest } from "node:https";
import { getServerConfig } from "./config.ts";

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
};

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
  deleteObject(key: string): Promise<void>;
  listObjects(prefix: string, limit?: number): Promise<string[]>;
}

const CANCEL_TIMEOUT_MS = 10_000;
/** Upper bound for any control-plane GCS call so a stalled provider cannot pin a request. */
export const GCS_REQUEST_TIMEOUT_MS = 30_000;
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

  constructor(options: GcsOptions = {}) {
    const config = getServerConfig();
    this.bucket = options.bucket ?? config.objectStoreBucket ?? "";
    this.staticToken = options.accessToken ?? config.gcpAccessToken;
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
    return fetch(url, { ...init, headers, cache: "no-store", signal: init.signal ?? AbortSignal.timeout(GCS_REQUEST_TIMEOUT_MS) });
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
    sizeBytes: number;
    metadata: Record<string, string>;
    origin?: string;
  }): Promise<string> {
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?uploadType=resumable&name=${encodeObjectName(input.key)}`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-upload-content-type": input.contentType,
      "x-upload-content-length": String(input.sizeBytes),
    };
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

  async cancelResumableUpload(uploadUrl: string): Promise<void> {
    const status = await deleteWithZeroContentLength(uploadUrl);
    if (![204, 404, 410, 499].includes(status)) {
      throw new Error(`GCS resumable upload cancellation failed (${status})`);
    }
  }

  async putJson(key: string, value: unknown): Promise<void> {
    await this.putObject(key, Buffer.from(JSON.stringify(value)), "application/json");
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

  async getJson<T>(key: string): Promise<T | null> {
    const response = await this.authorizedFetch(this.mediaUrl(key));
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GCS metadata read failed (${response.status})`);
    return response.json() as Promise<T>;
  }

  async getObject(key: string): Promise<{ bytes: Buffer; contentType?: string } | null> {
    const response = await this.authorizedFetch(this.mediaUrl(key));
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GCS object read failed (${response.status})`);
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? undefined,
    };
  }

  async getObjectMetadata(key: string): Promise<GcsObject | null> {
    const response = await this.authorizedFetch(`${this.metadataUrl(key)}?fields=generation,size,contentType,metadata,crc32c,md5Hash`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GCS object metadata read failed (${response.status})`);
    return response.json() as Promise<GcsObject>;
  }

  async getObjectPrefix(key: string, bytes = 32): Promise<Buffer> {
    const response = await this.authorizedFetch(this.mediaUrl(key), {
      headers: { range: `bytes=0-${Math.max(0, bytes - 1)}` },
    });
    if (!response.ok && response.status !== 206) throw new Error(`GCS object validation read failed (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
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
export function gcs(): GcsControlClient {
  if (!singleton) singleton = new GcsControlClient();
  return singleton;
}
