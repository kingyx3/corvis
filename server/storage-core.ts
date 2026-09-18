import { createHash, createHmac } from "node:crypto";
import { getConfig } from "@/server/config";

export type CompletedPart = { partNumber: number; etag: string };
type SignedHeaders = Record<string, string>;

function encodePath(path: string): string { return path.split("/").map((segment) => encodeURIComponent(segment)).join("/"); }
function encodeQuery(value: string): string { return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`); }
function hashHex(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function hmac(key: Buffer | string, value: string): Buffer { return createHmac("sha256", key).update(value).digest(); }
function signingKey(secret: string, date: string, region: string): Buffer { return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), "s3"), "aws4_request"); }
function amzTimestamp(date = new Date()): { timestamp: string; date: string } { const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, ""); return { timestamp: iso, date: iso.slice(0, 8) }; }
function canonicalQuery(params: URLSearchParams): string { return Array.from(params.entries()).sort(([ak,av],[bk,bv]) => ak === bk ? av.localeCompare(bv) : ak.localeCompare(bk)).map(([key,value]) => `${encodeQuery(key)}=${encodeQuery(value)}`).join("&"); }
function normalizeHeaders(headers: SignedHeaders): { canonical: string; signed: string } {
  const normalized = Object.entries(headers).map(([key,value]) => [key.toLowerCase().trim(), value.trim().replace(/\s+/g," ")] as const).sort(([a],[b]) => a.localeCompare(b));
  return { canonical: normalized.map(([key,value]) => `${key}:${value}\n`).join(""), signed: normalized.map(([key]) => key).join(";") };
}
function endpointFor(key: string): URL { const endpoint = new URL(getConfig().storage.endpoint); endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/${encodePath(key)}`.replace(/\/+/g, "/"); return endpoint; }
function xmlEscape(value: string): string { return value.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;"); }
function decodeXml(value: string): string { return value.replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&gt;/g,">").replace(/&lt;/g,"<").replace(/&amp;/g,"&"); }
function extractXml(text: string, tag: string): string | undefined { const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return match ? decodeXml(match[1]) : undefined; }
function objectHeaders(extra: SignedHeaders = {}): SignedHeaders {
  const config = getConfig();
  return { ...(config.storage.kmsKeyId ? { "x-amz-server-side-encryption":"aws:kms", "x-amz-server-side-encryption-aws-kms-key-id":config.storage.kmsKeyId } : { "x-amz-server-side-encryption":"AES256" }), ...extra };
}

async function signedFetch(method: string, key: string, options: { query?: Record<string,string>; body?: string|Buffer; headers?: SignedHeaders; range?: string } = {}): Promise<Response> {
  const config = getConfig();
  if (config.demoMode) throw new Error("S3 adapter is disabled in demo mode");
  const url = endpointFor(key); Object.entries(options.query || {}).forEach(([name,value]) => url.searchParams.set(name,value));
  const body = options.body ?? ""; const payloadHash = hashHex(body); const { timestamp, date } = amzTimestamp();
  const headers: SignedHeaders = { host:url.host, "x-amz-content-sha256":payloadHash, "x-amz-date":timestamp, ...(config.storage.sessionToken ? {"x-amz-security-token":config.storage.sessionToken}:{ }), ...(options.range ? {range:options.range}:{}), ...(options.headers || {}) };
  const normalized = normalizeHeaders(headers); const canonical = [method,url.pathname,canonicalQuery(url.searchParams),normalized.canonical,normalized.signed,payloadHash].join("\n");
  const scope = `${date}/${config.storage.region}/s3/aws4_request`; const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${hashHex(canonical)}`;
  const signature = createHmac("sha256", signingKey(config.storage.secretAccessKey,date,config.storage.region)).update(stringToSign).digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${config.storage.accessKeyId}/${scope}, SignedHeaders=${normalized.signed}, Signature=${signature}`;
  return fetch(url,{ method, headers, body: method === "GET" || method === "HEAD" ? undefined : body, cache:"no-store", signal:AbortSignal.timeout(60_000) });
}

export function presignUrl(method: "GET"|"PUT", key: string, options: { expiresSeconds?:number; query?:Record<string,string> } = {}): string {
  const config=getConfig(); if(config.demoMode) return `https://example.invalid/${encodePath(key)}`; const url=endpointFor(key); Object.entries(options.query||{}).forEach(([name,value])=>url.searchParams.set(name,value));
  const {timestamp,date}=amzTimestamp(); const scope=`${date}/${config.storage.region}/s3/aws4_request`; url.searchParams.set("X-Amz-Algorithm","AWS4-HMAC-SHA256"); url.searchParams.set("X-Amz-Credential",`${config.storage.accessKeyId}/${scope}`); url.searchParams.set("X-Amz-Date",timestamp); url.searchParams.set("X-Amz-Expires",String(Math.min(options.expiresSeconds||config.storage.presignTtlSeconds,3600))); url.searchParams.set("X-Amz-SignedHeaders","host"); if(config.storage.sessionToken) url.searchParams.set("X-Amz-Security-Token",config.storage.sessionToken);
  const canonical=[method,url.pathname,canonicalQuery(url.searchParams),`host:${url.host}\n`,"host","UNSIGNED-PAYLOAD"].join("\n"); const stringToSign=`AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${hashHex(canonical)}`; const signature=createHmac("sha256",signingKey(config.storage.secretAccessKey,date,config.storage.region)).update(stringToSign).digest("hex"); url.searchParams.set("X-Amz-Signature",signature); return url.toString();
}

export async function createMultipartUpload(key:string, metadata:Record<string,string>, contentType:string):Promise<string>{ const headers=objectHeaders({"content-type":contentType,...Object.fromEntries(Object.entries(metadata).map(([name,value])=>[`x-amz-meta-${name.toLowerCase()}`,value]))}); const response=await signedFetch("POST",key,{query:{uploads:""},headers}); const text=await response.text(); if(!response.ok) throw new Error(`CreateMultipartUpload failed (${response.status}): ${text.slice(0,500)}`); const uploadId=extractXml(text,"UploadId"); if(!uploadId) throw new Error("CreateMultipartUpload response did not include UploadId"); return uploadId; }
export function presignUploadPart(key:string,uploadId:string,partNumber:number):string{return presignUrl("PUT",key,{query:{partNumber:String(partNumber),uploadId}});}
export async function listMultipartParts(key:string,uploadId:string):Promise<CompletedPart[]>{const response=await signedFetch("GET",key,{query:{uploadId}}); const text=await response.text(); if(!response.ok) throw new Error(`ListParts failed (${response.status}): ${text.slice(0,500)}`); return Array.from(text.matchAll(/<Part>[\s\S]*?<PartNumber>(\d+)<\/PartNumber>[\s\S]*?<ETag>"?([^<"]+)"?<\/ETag>[\s\S]*?<\/Part>/g)).map((match)=>({partNumber:Number(match[1]),etag:match[2]})).sort((a,b)=>a.partNumber-b.partNumber);}
export async function completeMultipartUpload(key:string,uploadId:string,parts:CompletedPart[]):Promise<void>{const body=`<CompleteMultipartUpload>${parts.sort((a,b)=>a.partNumber-b.partNumber).map((part)=>`<Part><PartNumber>${part.partNumber}</PartNumber><ETag>"${xmlEscape(part.etag)}"</ETag></Part>`).join("")}</CompleteMultipartUpload>`; const response=await signedFetch("POST",key,{query:{uploadId},body,headers:{"content-type":"application/xml"}}); const text=await response.text(); if(!response.ok||/<Error>/.test(text)) throw new Error(`CompleteMultipartUpload failed (${response.status}): ${text.slice(0,500)}`);}
export async function abortMultipartUpload(key:string,uploadId:string):Promise<void>{const response=await signedFetch("DELETE",key,{query:{uploadId}}); if(!response.ok&&response.status!==404) throw new Error(`AbortMultipartUpload failed (${response.status})`);}
export async function getObjectRange(key:string,start:number,end:number):Promise<Buffer>{const response=await signedFetch("GET",key,{range:`bytes=${start}-${end}`}); if(!response.ok&&response.status!==206) throw new Error(`S3 range read failed (${response.status})`); return Buffer.from(await response.arrayBuffer());}
export async function copyObject(sourceKey:string,destinationKey:string,metadata:Record<string,string>={},contentType="application/octet-stream"):Promise<void>{const source=`/${getConfig().storage.bucket}/${sourceKey}`; const response=await signedFetch("PUT",destinationKey,{headers:objectHeaders({"x-amz-copy-source":encodeURI(source),"x-amz-metadata-directive":"REPLACE","content-type":contentType,...Object.fromEntries(Object.entries(metadata).map(([name,value])=>[`x-amz-meta-${name.toLowerCase()}`,value]))})}); const text=await response.text(); if(!response.ok||/<Error>/.test(text)) throw new Error(`CopyObject failed (${response.status}): ${text.slice(0,500)}`);}
export async function deleteObject(key:string):Promise<void>{const response=await signedFetch("DELETE",key); if(!response.ok&&response.status!==404) throw new Error(`DeleteObject failed (${response.status})`);}
export async function putObject(key:string,body:Buffer|string,contentType:string,metadata:Record<string,string>={}):Promise<void>{const response=await signedFetch("PUT",key,{body,headers:objectHeaders({"content-type":contentType,...Object.fromEntries(Object.entries(metadata).map(([name,value])=>[`x-amz-meta-${name.toLowerCase()}`,value]))})}); if(!response.ok) throw new Error(`PutObject failed (${response.status}): ${(await response.text()).slice(0,500)}`);}
