import { getServerConfig } from "@/lib/server/config";

type TokenResponse = { access_token?: string; expires_in?: number };
type GcsObject = {
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

function encodeObjectName(value: string): string {
  return encodeURIComponent(value);
}

export class GcsControlClient {
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
      { headers: { "Metadata-Flavor": "Google" }, cache: "no-store" },
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
    return fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      cache: "no-store",
    });
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
      body: JSON.stringify({
        name: input.key,
        contentType: input.contentType,
        metadata: input.metadata,
      }),
    });
    if (!response.ok) throw new Error(`GCS resumable upload initiation failed (${response.status})`);
    const location = response.headers.get("location");
    if (!location) throw new Error("GCS resumable upload initiation returned no session URI");
    return location;
  }

  async cancelResumableUpload(uploadUrl: string): Promise<void> {
    const response = await fetch(uploadUrl, { method: "DELETE", cache: "no-store" });
    if (![204, 404, 410, 499].includes(response.status)) {
      throw new Error(`GCS resumable upload cancellation failed (${response.status})`);
    }
  }

  async putJson(key: string, value: unknown): Promise<void> {
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?uploadType=media&name=${encodeObjectName(key)}`;
    const response = await this.authorizedFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
    if (!response.ok) throw new Error(`GCS metadata write failed (${response.status})`);
  }

  async getJson<T>(key: string): Promise<T | null> {
    const response = await this.authorizedFetch(this.mediaUrl(key));
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GCS metadata read failed (${response.status})`);
    return response.json() as Promise<T>;
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
