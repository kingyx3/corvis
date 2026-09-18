import { createHash, createHmac } from "crypto";
import { getServerConfig } from "@/lib/server/config";

export type AwsCredentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
export type MultipartPart = { partNumber: number; etag: string };

type S3Options = {
  bucket?: string;
  region?: string;
  endpoint?: string;
  kmsKeyId?: string;
  credentials?: AwsCredentials;
  presignTtlSeconds?: number;
};

function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function hmac(key: string | Buffer, value: string): Buffer { return createHmac("sha256", key).update(value).digest(); }
function encode(value: string): string { return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`); }
function encodePath(path: string): string { return `/${path.split("/").filter(Boolean).map(encode).join("/")}`; }
function amzTimestamp(date: Date): string { return date.toISOString().replace(/[:-]|\.\d{3}/g, ""); }
function dateStamp(date: Date): string { return amzTimestamp(date).slice(0, 8); }
function normalizeHeaderValue(value: string): string { return value.trim().replace(/\s+/g, " "); }

function canonicalQuery(params: URLSearchParams): string {
  return [...params.entries()].sort(([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue)).map(([key, value]) => `${encode(key)}=${encode(value)}`).join("&");
}

function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

function xmlValue(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1]?.replaceAll("&quot;", '"').replaceAll("&amp;", "&").trim();
}

export function parseMultipartParts(xml: string): MultipartPart[] {
  return [...xml.matchAll(/<Part>([\s\S]*?)<\/Part>/gi)].map((match) => ({
    partNumber: Number(xmlValue(match[1], "PartNumber")),
    etag: (xmlValue(match[1], "ETag") || "").replaceAll('"', ""),
  })).filter((part) => Number.isInteger(part.partNumber) && part.partNumber > 0 && part.etag);
}

function escapeXml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }

export class S3ControlClient {
  readonly bucket: string;
  readonly region: string;
  readonly endpoint?: string;
  readonly kmsKeyId?: string;
  readonly credentials: AwsCredentials;
  readonly presignTtlSeconds: number;

  constructor(options: S3Options = {}) {
    const config = getServerConfig();
    this.bucket = options.bucket ?? config.objectStoreBucket ?? "";
    this.region = options.region ?? config.s3Region ?? "";
    this.endpoint = options.endpoint ?? config.s3Endpoint;
    this.kmsKeyId = options.kmsKeyId ?? config.s3KmsKeyId;
    this.credentials = options.credentials ?? {
      accessKeyId: config.awsAccessKeyId ?? "",
      secretAccessKey: config.awsSecretAccessKey ?? "",
      sessionToken: config.awsSessionToken,
    };
    this.presignTtlSeconds = options.presignTtlSeconds ?? config.s3PresignTtlSeconds ?? 900;
    if (!this.bucket || !this.region || !this.credentials.accessKeyId || !this.credentials.secretAccessKey) {
      throw new Error("S3 production adapter is not configured");
    }
  }

  private objectUrl(key: string, query?: URLSearchParams): URL {
    const path = encodePath(key);
    const base = this.endpoint
      ? `${this.endpoint.replace(/\/$/, "")}/${encode(this.bucket)}${path}`
      : `https://${this.bucket}.s3.${this.region}.amazonaws.com${path}`;
    const url = new URL(base);
    if (query) query.forEach((value, name) => url.searchParams.append(name, value));
    return url;
  }

  private host(url: URL): string { return url.host; }

  private authorization(method: string, url: URL, headers: Record<string, string>, payloadHash: string, now = new Date()): Record<string, string> {
    const timestamp = amzTimestamp(now);
    const day = dateStamp(now);
    const normalized: Record<string, string> = { ...Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), normalizeHeaderValue(value)])), host: this.host(url), "x-amz-date": timestamp, "x-amz-content-sha256": payloadHash };
    if (this.credentials.sessionToken) normalized["x-amz-security-token"] = this.credentials.sessionToken;
    const signedHeaderNames = Object.keys(normalized).sort();
    const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${normalized[name]}\n`).join("");
    const scope = `${day}/${this.region}/s3/aws4_request`;
    const canonicalRequest = [method, url.pathname, canonicalQuery(url.searchParams), canonicalHeaders, signedHeaderNames.join(";"), payloadHash].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", timestamp, scope, sha256(canonicalRequest)].join("\n");
    const signature = createHmac("sha256", signingKey(this.credentials.secretAccessKey, day, this.region, "s3")).update(stringToSign).digest("hex");
    return {
      ...normalized,
      authorization: `AWS4-HMAC-SHA256 Credential=${this.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames.join(";")}, Signature=${signature}`,
    };
  }

  private async signedFetch(method: string, key: string, options: { query?: URLSearchParams; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
    const url = this.objectUrl(key, options.query);
    const body = options.body ?? "";
    const payloadHash = sha256(body);
    const headers = this.authorization(method, url, options.headers ?? {}, payloadHash);
    return fetch(url, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : body, cache: "no-store" });
  }

  presignUploadPart(key: string, uploadId: string, partNumber: number, now = new Date()): string {
    const url = this.objectUrl(key);
    url.searchParams.set("partNumber", String(partNumber));
    url.searchParams.set("uploadId", uploadId);
    const timestamp = amzTimestamp(now);
    const day = dateStamp(now);
    const scope = `${day}/${this.region}/s3/aws4_request`;
    url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
    url.searchParams.set("X-Amz-Credential", `${this.credentials.accessKeyId}/${scope}`);
    url.searchParams.set("X-Amz-Date", timestamp);
    url.searchParams.set("X-Amz-Expires", String(this.presignTtlSeconds));
    url.searchParams.set("X-Amz-SignedHeaders", "host");
    if (this.credentials.sessionToken) url.searchParams.set("X-Amz-Security-Token", this.credentials.sessionToken);
    const canonicalRequest = ["PUT", url.pathname, canonicalQuery(url.searchParams), `host:${this.host(url)}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", timestamp, scope, sha256(canonicalRequest)].join("\n");
    const signature = createHmac("sha256", signingKey(this.credentials.secretAccessKey, day, this.region, "s3")).update(stringToSign).digest("hex");
    url.searchParams.set("X-Amz-Signature", signature);
    return url.toString();
  }

  async createMultipartUpload(key: string, metadata: Record<string, string>): Promise<string> {
    const query = new URLSearchParams(); query.set("uploads", "");
    const headers: Record<string, string> = { "content-type": "application/octet-stream", "x-amz-server-side-encryption": "aws:kms" };
    if (this.kmsKeyId) headers["x-amz-server-side-encryption-aws-kms-key-id"] = this.kmsKeyId;
    for (const [name, value] of Object.entries(metadata)) headers[`x-amz-meta-${name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`] = value;
    const response = await this.signedFetch("POST", key, { query, headers });
    const xml = await response.text();
    if (!response.ok) throw new Error(`S3 create multipart upload failed (${response.status})`);
    const uploadId = xmlValue(xml, "UploadId");
    if (!uploadId) throw new Error("S3 did not return a multipart upload id");
    return uploadId;
  }

  async listParts(key: string, uploadId: string): Promise<MultipartPart[]> {
    const query = new URLSearchParams({ uploadId });
    const response = await this.signedFetch("GET", key, { query });
    if (!response.ok) throw new Error(`S3 list parts failed (${response.status})`);
    return parseMultipartParts(await response.text());
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: MultipartPart[]): Promise<{ versionId?: string }> {
    const query = new URLSearchParams({ uploadId });
    const body = `<CompleteMultipartUpload>${parts.map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>\"${escapeXml(part.etag)}\"</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
    const response = await this.signedFetch("POST", key, { query, headers: { "content-type": "application/xml" }, body });
    if (!response.ok) throw new Error(`S3 complete multipart upload failed (${response.status})`);
    return { versionId: response.headers.get("x-amz-version-id") || undefined };
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const response = await this.signedFetch("DELETE", key, { query: new URLSearchParams({ uploadId }) });
    if (!response.ok && response.status !== 404) throw new Error(`S3 abort multipart upload failed (${response.status})`);
  }

  async putJson(key: string, value: unknown): Promise<void> {
    const body = JSON.stringify(value);
    const headers: Record<string, string> = { "content-type": "application/json", "x-amz-server-side-encryption": "aws:kms" };
    if (this.kmsKeyId) headers["x-amz-server-side-encryption-aws-kms-key-id"] = this.kmsKeyId;
    const response = await this.signedFetch("PUT", key, { headers, body });
    if (!response.ok) throw new Error(`S3 metadata write failed (${response.status})`);
  }

  async getJson<T>(key: string): Promise<T | null> {
    const response = await this.signedFetch("GET", key);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`S3 metadata read failed (${response.status})`);
    return response.json() as Promise<T>;
  }

  async getObjectPrefix(key: string, bytes = 32): Promise<Buffer> {
    const response = await this.signedFetch("GET", key, { headers: { range: `bytes=0-${Math.max(0, bytes - 1)}` } });
    if (!response.ok && response.status !== 206) throw new Error(`S3 object validation read failed (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }

  async getTags(key: string): Promise<Record<string, string>> {
    const query = new URLSearchParams(); query.set("tagging", "");
    const response = await this.signedFetch("GET", key, { query });
    if (!response.ok) return {};
    const xml = await response.text();
    const tags: Record<string, string> = {};
    for (const match of xml.matchAll(/<Tag>([\s\S]*?)<\/Tag>/gi)) {
      const name = xmlValue(match[1], "Key"); const value = xmlValue(match[1], "Value");
      if (name && value != null) tags[name] = value;
    }
    return tags;
  }
}

let singleton: S3ControlClient | undefined;
export function s3(): S3ControlClient {
  if (!singleton) singleton = new S3ControlClient();
  return singleton;
}
