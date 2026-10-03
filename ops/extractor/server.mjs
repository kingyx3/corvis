import { createHash } from "node:crypto";
import http from "node:http";

const PORT = Number(process.env.PORT || "8080");
const CONTRACT_VERSION = "1";
const SCHEMA_VERSION = "1.6";
const SKILL_ID = "quarterly_fund_report_extraction";
const SKILL_VERSION = "2.1";
const ORCHESTRATION_POLICY_VERSION = "1";
const PRODUCER = "corvis-extraction-harness";
const PRODUCER_VERSION = process.env.CORVIS_EXTRACTOR_VERSION || "1";
const SKILL_PAGE_ID = process.env.CORVIS_EXTRACTION_SKILL_PAGE_ID || "426007";
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_REPRESENTATION_BYTES = Number(process.env.CORVIS_EXTRACTOR_MAX_REPRESENTATION_BYTES || 16 * 1024 * 1024);
const MAX_MODEL_RESPONSE_BYTES = Number(process.env.CORVIS_EXTRACTOR_MAX_MODEL_RESPONSE_BYTES || 8 * 1024 * 1024);
const MAP_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.CORVIS_EXTRACTOR_MAP_CONCURRENCY || "3")));
const MAP_PAGES = Math.max(1, Math.min(24, Number(process.env.CORVIS_EXTRACTOR_MAP_PAGES || "8")));
const MODEL_TIMEOUT_MS = Math.max(15_000, Math.min(420_000, Number(process.env.CORVIS_EXTRACTOR_MODEL_TIMEOUT_MS || "180000")));
const LITELLM_URL = requiredEnv("CORVIS_LITELLM_URL").replace(/\/$/, "");
const LITELLM_AUDIENCE = (process.env.CORVIS_LITELLM_AUDIENCE || LITELLM_URL).replace(/\/$/, "");
const LITELLM_MASTER_KEY = requiredEnv("LITELLM_MASTER_KEY");
const ALLOWED_BUCKET = requiredEnv("CORVIS_OBJECT_STORE_BUCKET");
const MODEL_MAP = parseModelMap(requiredEnv("CORVIS_LITELLM_MODELS_JSON"));
const PRIMARY_ALIAS = process.env.CORVIS_EXTRACTION_MODEL || "corvis-extract-primary";
const VERIFIER_ALIAS = process.env.CORVIS_EXTRACTION_VERIFIER_MODEL || "corvis-extract-verifier";

const CANDIDATE_TYPES = new Set([
  "fund", "company", "holding", "instrument", "lifecycle_event",
  "metric_observation", "financial_statement_line", "exception",
]);
const FUND_ATTRIBUTION_TYPES = new Set([
  "fund", "company", "holding", "instrument", "metric_observation", "financial_statement_line",
]);
const EXTRACTION_METHODS = new Set(["native_text", "table_parser", "ocr", "vision", "spreadsheet_parser"]);
const PAGE_COVERAGE_STATES = new Set(["primary", "overlap_shared", "excluded", "exception"]);

let cachedAccessToken;
let cachedAccessTokenExpiresAt = 0;
const identityTokens = new Map();

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

function parseModelMap(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("CORVIS_LITELLM_MODELS_JSON must be valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CORVIS_LITELLM_MODELS_JSON must be an object");
  const result = {};
  for (const [alias, model] of Object.entries(value)) {
    if (!/^corvis-extract-[a-z0-9-]+$/.test(alias) || typeof model !== "string" || !model.includes("/")) {
      throw new Error(`invalid LiteLLM model mapping for ${alias}`);
    }
    result[alias] = model.trim();
  }
  if (!result[PRIMARY_ALIAS]) throw new Error(`primary extraction alias ${PRIMARY_ALIAS} is not configured`);
  return result;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : undefined; }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

async function fetchBounded(url, init = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("request timed out")), timeoutMs);
  try { return await fetch(url, { ...init, signal: controller.signal, cache: "no-store" }); }
  finally { clearTimeout(timer); }
}

async function googleAccessToken() {
  if (cachedAccessToken && cachedAccessTokenExpiresAt - Date.now() > 60_000) return cachedAccessToken;
  const response = await fetchBounded(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } }, 5_000,
  );
  if (!response.ok) throw new Error(`GCP access token failed (${response.status})`);
  const body = await response.json();
  if (!body.access_token) throw new Error("GCP access token response was empty");
  cachedAccessToken = body.access_token;
  cachedAccessTokenExpiresAt = Date.now() + Math.max(60, Number(body.expires_in || 300)) * 1000;
  return cachedAccessToken;
}

async function googleIdentityToken(audience) {
  const cached = identityTokens.get(audience);
  if (cached && cached.expiresAt - Date.now() > 60_000) return cached.value;
  const url = new URL("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity");
  url.searchParams.set("audience", audience);
  url.searchParams.set("format", "full");
  const response = await fetchBounded(url, { headers: { "Metadata-Flavor": "Google" } }, 5_000);
  if (!response.ok) throw new Error(`GCP identity token failed (${response.status})`);
  const value = (await response.text()).trim();
  if (!value) throw new Error("GCP identity token response was empty");
  identityTokens.set(audience, { value, expiresAt: Date.now() + 45 * 60 * 1000 });
  return value;
}

function parseGcsUri(uri) {
  if (typeof uri !== "string" || !uri.startsWith("gs://")) throw new HttpError(400, "GCS URI is required");
  const remainder = uri.slice(5);
  const slash = remainder.indexOf("/");
  if (slash <= 0 || slash === remainder.length - 1) throw new HttpError(400, "invalid GCS URI");
  return { bucket: remainder.slice(0, slash), key: remainder.slice(slash + 1) };
}

function requireAllowedBucket(uri) {
  const parsed = parseGcsUri(uri);
  if (parsed.bucket !== ALLOWED_BUCKET) throw new HttpError(403, "object is outside the configured Corvis evidence bucket");
  return parsed;
}

async function gcsMetadata(uri, generation) {
  const { bucket, key } = requireAllowedBucket(uri);
  const token = await googleAccessToken();
  const url = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}`);
  url.searchParams.set("fields", "generation,size,contentType,metadata");
  if (generation) url.searchParams.set("generation", generation);
  const response = await fetchBounded(url, { headers: { authorization: `Bearer ${token}` } }, 10_000);
  if (!response.ok) throw new Error(`GCS metadata read failed (${response.status})`);
  return response.json();
}

async function gcsDownload(uri, generation) {
  const { bucket, key } = requireAllowedBucket(uri);
  const token = await googleAccessToken();
  const url = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}`);
  url.searchParams.set("alt", "media");
  if (generation) url.searchParams.set("generation", generation);
  const response = await fetchBounded(url, { headers: { authorization: `Bearer ${token}` } }, 60_000);
  if (!response.ok) throw new Error(`GCS object read failed (${response.status})`);
  const declared = Number(response.headers.get("content-length") || "0");
  if (declared > MAX_REPRESENTATION_BYTES) throw new Error("representation exceeds extraction size limit");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_REPRESENTATION_BYTES) throw new Error("representation exceeds extraction size limit");
  return bytes;
}

async function gcsUploadImmutable(uri, bytes, contentType, metadata) {
  const { bucket, key } = requireAllowedBucket(uri);
  const token = await googleAccessToken();
  const boundary = `corvis_${createHash("sha256").update(uri).digest("hex").slice(0, 24)}`;
  const meta = Buffer.from(JSON.stringify({ name: key, contentType, metadata }), "utf8");
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
    meta,
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`);
  url.searchParams.set("uploadType", "multipart");
  url.searchParams.set("name", key);
  url.searchParams.set("ifGenerationMatch", "0");
  const response = await fetchBounded(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` },
    body,
  }, 60_000);
  if (response.status === 412) {
    const existing = await gcsMetadata(uri);
    if (existing.metadata?.["corvis-content-sha256"] !== sha256(bytes) || Number(existing.size) !== bytes.length) {
      throw new Error("immutable GCS output already exists with conflicting content");
    }
    return existing;
  }
  if (!response.ok) throw new Error(`GCS immutable upload failed (${response.status})`);
  return response.json();
}

function parseAtlassianCredentials() {
  let value;
  try { value = JSON.parse(requiredEnv("CORVIS_ATLASSIAN_SKILL_READ_CREDENTIALS_JSON")); }
  catch { throw new Error("CORVIS_ATLASSIAN_SKILL_READ_CREDENTIALS_JSON must be valid JSON"); }
  const credentials = object(value);
  if (!credentials) throw new Error("Atlassian skill-read credentials must be an object");
  const baseUrl = String(credentials.baseUrl || credentials.base_url || credentials.url || "").replace(/\/$/, "");
  const username = String(credentials.email || credentials.username || "");
  const token = String(credentials.apiToken || credentials.api_token || credentials.token || "");
  if (!/^https:\/\//.test(baseUrl) || !username || !token) throw new Error("Atlassian skill-read credentials require HTTPS baseUrl, email/username, and apiToken/token");
  return { baseUrl, username, token };
}

async function fetchSkillSnapshot() {
  const { baseUrl, username, token } = parseAtlassianCredentials();
  const url = new URL(`${baseUrl}/wiki/api/v2/pages/${encodeURIComponent(SKILL_PAGE_ID)}`);
  url.searchParams.set("body-format", "storage");
  const response = await fetchBounded(url, {
    headers: { authorization: `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`, accept: "application/json" },
  }, 20_000);
  if (!response.ok) throw new Error(`Confluence skill snapshot failed (${response.status})`);
  const page = await response.json();
  const content = page.body?.storage?.value;
  if (typeof content !== "string" || !content.trim()) throw new Error("Confluence skill snapshot had no body");
  return { pageId: String(page.id || SKILL_PAGE_ID), version: String(page.version?.number || "unknown"), content };
}

function findPages(value) {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value.pages)) return value.pages;
  if (value.document && Array.isArray(value.document.pages)) return value.document.pages;
  if (value.interpretation && Array.isArray(value.interpretation.pages)) return value.interpretation.pages;
  return undefined;
}

function findSheets(value) {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value.sheets)) return value.sheets;
  if (value.workbook && Array.isArray(value.workbook.sheets)) return value.workbook.sheets;
  return undefined;
}

function pageNumber(page, index) {
  const candidate = Number(page?.pageNumber ?? page?.page_number ?? page?.number ?? index + 1);
  return Number.isSafeInteger(candidate) && candidate > 0 ? candidate : index + 1;
}

function sheetName(sheet, index) {
  const value = sheet?.sheetName ?? sheet?.sheet_name ?? sheet?.name;
  return typeof value === "string" && value.trim() ? value.trim() : `Sheet${index + 1}`;
}

function workUnits(representationText) {
  let parsed;
  try { parsed = JSON.parse(representationText); } catch { parsed = undefined; }
  const pages = findPages(parsed);
  if (pages?.length) {
    const result = [];
    for (let start = 0; start < pages.length; start += MAP_PAGES) {
      const end = Math.min(pages.length, start + MAP_PAGES);
      const contextStart = Math.max(0, start - 1);
      const contextEnd = Math.min(pages.length, end + 1);
      result.push({
        id: `wu-${String(result.length + 1).padStart(4, "0")}`,
        kind: "pages",
        targetPages: pages.slice(start, end).map((page, i) => pageNumber(page, start + i)),
        targetSheets: [],
        source: JSON.stringify({ pages: pages.slice(contextStart, contextEnd) }),
      });
    }
    return { units: result, pageCount: pages.length, sheets: [] };
  }
  const sheets = findSheets(parsed);
  if (sheets?.length) {
    const result = sheets.map((sheet, index) => ({
      id: `wu-${String(index + 1).padStart(4, "0")}`,
      kind: "sheet",
      targetPages: [],
      targetSheets: [sheetName(sheet, index)],
      source: JSON.stringify({ sheet }),
    }));
    return { units: result, pageCount: 0, sheets: result.flatMap((unit) => unit.targetSheets) };
  }
  if (!parsed) throw new Error("document_interpretation_v1 representation must be JSON");
  return {
    units: [{ id: "wu-0001", kind: "document", targetPages: [], targetSheets: [], source: representationText }],
    pageCount: Number.isSafeInteger(Number(parsed.pageCount)) ? Number(parsed.pageCount) : 0,
    sheets: [],
  };
}

function modelLineage(alias) {
  const configured = MODEL_MAP[alias];
  if (!configured) throw new Error(`model alias ${alias} is not configured`);
  const slash = configured.indexOf("/");
  return { provider: configured.slice(0, slash), model: configured.slice(slash + 1), version: configured };
}

async function callModel(alias, system, user) {
  const cloudRunToken = await googleIdentityToken(LITELLM_AUDIENCE);
  const response = await fetchBounded(`${LITELLM_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${LITELLM_MASTER_KEY}`,
      "x-serverless-authorization": `Bearer ${cloudRunToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: alias,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  }, MODEL_TIMEOUT_MS);
  const declared = Number(response.headers.get("content-length") || "0");
  if (declared > MAX_MODEL_RESPONSE_BYTES) throw new Error("model response exceeded extraction limit");
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_MODEL_RESPONSE_BYTES) throw new Error("model response exceeded extraction limit");
  if (!response.ok) throw new Error(`LiteLLM model call failed (${response.status})`);
  let envelope;
  try { envelope = JSON.parse(text); } catch { throw new Error("LiteLLM returned invalid JSON"); }
  let content = envelope.choices?.[0]?.message?.content;
  if (Array.isArray(content)) content = content.map((item) => item?.text || item?.content || "").join("");
  if (typeof content !== "string") throw new Error("LiteLLM response did not contain model content");
  try { return JSON.parse(content); } catch { throw new Error("model output was not valid JSON"); }
}

function mapPrompt(skill, unit, request) {
  const target = unit.kind === "pages" ? `target pages ${unit.targetPages.join(", ")}` : unit.kind === "sheet" ? `target sheet ${unit.targetSheets.join(", ")}` : "the supplied document segment";
  return [
    `Authoritative Corvis skill snapshot (Confluence page ${skill.pageId}, version ${skill.version}):`,
    skill.content,
    "",
    `Extraction run: ${request.extractionRunId}`,
    `Work unit: ${unit.id}; extract only facts anchored in ${target}. Adjacent pages, when present, are context only and must not be emitted unless the source reference is on a target page.`,
    "Return one JSON object with keys candidates and coveredPages. candidates is an array. Each candidate must have candidateKey, candidateType, payload, confidence, provenance, exceptionCodes, sourceReferences. sourceReferences must carry exact pageNumber or sheetName, documentSegmentId, workUnitId, fundContextIds, pageCoverageState and extractionMethod. Use full source-reported company operating values; never ownership-prorate unless the source itself reports an ownership-adjusted value. Never invent a fund attribution. Use FUND_ATTRIBUTION_UNRESOLVED when materially unresolved.",
    `For this work unit coveredPages must equal exactly ${JSON.stringify(unit.targetPages)}.`,
    "",
    "Representation segment:",
    unit.source,
  ].join("\n");
}

function normalizeCandidate(candidate) {
  const value = object(candidate);
  if (!value || typeof value.candidateKey !== "string" || !value.candidateKey.trim()) throw new Error("model candidate missing candidateKey");
  if (!CANDIDATE_TYPES.has(value.candidateType)) throw new Error(`model candidate ${value.candidateKey} has unsupported candidateType`);
  if (!object(value.payload) || !object(value.confidence) || !object(value.provenance)) throw new Error(`model candidate ${value.candidateKey} has invalid structured fields`);
  if (!Array.isArray(value.sourceReferences) || value.sourceReferences.length === 0) throw new Error(`model candidate ${value.candidateKey} has no source references`);
  const references = value.sourceReferences.map((reference) => {
    const ref = object(reference);
    if (!ref) throw new Error(`model candidate ${value.candidateKey} has invalid source reference`);
    const hasPage = Number.isSafeInteger(Number(ref.pageNumber)) && Number(ref.pageNumber) > 0;
    const hasSheet = typeof ref.sheetName === "string" && ref.sheetName.trim();
    if (!hasPage && !hasSheet) throw new Error(`model candidate ${value.candidateKey} source reference lacks page/sheet evidence`);
    if (typeof ref.documentSegmentId !== "string" || !ref.documentSegmentId.trim()) throw new Error(`model candidate ${value.candidateKey} source reference lacks documentSegmentId`);
    if (typeof ref.workUnitId !== "string" || !ref.workUnitId.trim()) throw new Error(`model candidate ${value.candidateKey} source reference lacks workUnitId`);
    if (!Array.isArray(ref.fundContextIds)) throw new Error(`model candidate ${value.candidateKey} source reference lacks fundContextIds`);
    if (!PAGE_COVERAGE_STATES.has(ref.pageCoverageState)) throw new Error(`model candidate ${value.candidateKey} has invalid pageCoverageState`);
    if (!EXTRACTION_METHODS.has(ref.extractionMethod)) throw new Error(`model candidate ${value.candidateKey} has invalid extractionMethod`);
    return ref;
  });
  const confidence = {};
  for (const [key, raw] of Object.entries(value.confidence)) {
    const score = Number(raw);
    if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error(`model candidate ${value.candidateKey} confidence is outside 0..1`);
    confidence[key] = score;
  }
  if (Object.keys(confidence).length === 0) throw new Error(`model candidate ${value.candidateKey} has no confidence dimensions`);
  return {
    candidateKey: value.candidateKey.trim(), candidateType: value.candidateType,
    payload: value.payload, confidence, provenance: value.provenance,
    exceptionCodes: Array.isArray(value.exceptionCodes) ? value.exceptionCodes.map(String) : [],
    sourceReferences: references,
  };
}

async function mapUnit(skill, unit, request) {
  const result = object(await callModel(PRIMARY_ALIAS,
    "You are a deterministic Corvis private-markets extraction worker. Follow the supplied authoritative skill exactly. Do not return prose outside the required JSON object.",
    mapPrompt(skill, unit, request)));
  if (!result || !Array.isArray(result.candidates)) throw new Error(`work unit ${unit.id} returned no candidates array`);
  const covered = Array.isArray(result.coveredPages) ? result.coveredPages.map(Number).sort((a, b) => a - b) : [];
  const expected = [...unit.targetPages].sort((a, b) => a - b);
  if (stableJson(covered) !== stableJson(expected)) throw new Error(`work unit ${unit.id} did not attest exact target page coverage`);
  return result.candidates.map(normalizeCandidate);
}

async function mapConcurrent(skill, units, request) {
  const output = new Array(units.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= units.length) return;
      output[index] = await mapUnit(skill, units[index], request);
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAP_CONCURRENCY, units.length) }, () => worker()));
  return output.flat();
}

async function reduceCandidates(skill, candidates, request) {
  const alias = MODEL_MAP[VERIFIER_ALIAS] ? VERIFIER_ALIAS : PRIMARY_ALIAS;
  const payload = JSON.stringify(candidates);
  if (Buffer.byteLength(payload) > MAX_REPRESENTATION_BYTES) throw new Error("mapped candidate set exceeds reducer input limit");
  const result = object(await callModel(alias,
    "You are the Corvis global extraction reducer and independent consistency checker. Return only a JSON object. Preserve exact source evidence. Never create a fact unsupported by the supplied mapped candidates.",
    [
      `Authoritative skill snapshot page ${skill.pageId}, version ${skill.version}. Semantic skill version ${SKILL_VERSION}.`,
      skill.content,
      `Extraction run ${request.extractionRunId}. Reconcile duplicate or conflicting mapped candidates, preserve distinct fund/holding paths, and return {\"candidates\":[...]}. Every retained candidate must keep exact sourceReferences and dimension confidence.`,
      payload,
    ].join("\n\n")));
  if (!result || !Array.isArray(result.candidates)) throw new Error("global reducer returned no candidates array");
  const normalized = result.candidates.map(normalizeCandidate).sort((a, b) => a.candidateKey.localeCompare(b.candidateKey));
  const keys = new Set();
  for (const candidate of normalized) {
    if (keys.has(candidate.candidateKey)) throw new Error(`global reducer repeated candidateKey ${candidate.candidateKey}`);
    keys.add(candidate.candidateKey);
  }
  return normalized;
}

function unresolvedAttributionCount(candidates) {
  let count = 0;
  for (const candidate of candidates) {
    if (!FUND_ATTRIBUTION_TYPES.has(candidate.candidateType)) continue;
    const contexts = new Set(candidate.sourceReferences.flatMap((reference) => reference.fundContextIds || []).filter(Boolean));
    if (contexts.size === 0 && !candidate.exceptionCodes.includes("FUND_ATTRIBUTION_UNRESOLVED")) count += 1;
  }
  return count;
}

function validateRequest(body) {
  const request = object(body);
  if (!request) throw new HttpError(400, "request must be a JSON object");
  const required = ["extractionRunId", "tenantId", "documentId", "artifactVersionId"];
  for (const key of required) if (typeof request[key] !== "string" || !request[key].trim()) throw new HttpError(400, `missing ${key}`);
  if (request.extractionContractVersion !== CONTRACT_VERSION || request.schemaVersion !== SCHEMA_VERSION || request.skillId !== SKILL_ID || request.skillVersion !== SKILL_VERSION) {
    throw new HttpError(409, "unsupported Corvis extraction contract");
  }
  if (request.orchestrationPolicy?.version !== ORCHESTRATION_POLICY_VERSION) throw new HttpError(409, "unsupported orchestration policy");
  const representation = object(request.representation);
  const output = object(request.output);
  if (!representation || !output || output.format !== "jsonl") throw new HttpError(400, "representation and JSONL output are required");
  for (const key of ["representationId", "representationType", "objectUri", "storageGeneration", "contentSha256"]) {
    if (typeof representation[key] !== "string" || !representation[key].trim()) throw new HttpError(400, `representation.${key} is required`);
  }
  if (representation.representationType !== "document_interpretation_v1") throw new HttpError(409, "extraction requires document_interpretation_v1");
  if (!/^[0-9a-f]{64}$/i.test(representation.contentSha256)) throw new HttpError(400, "representation contentSha256 is invalid");
  if (typeof output.objectUri !== "string") throw new HttpError(400, "output.objectUri is required");
  const expectedKey = `extractions/${request.tenantId}/${request.documentId}/${representation.representationId}/${request.extractionRunId}.jsonl`;
  const parsedOutput = requireAllowedBucket(output.objectUri);
  if (parsedOutput.key !== expectedKey) throw new HttpError(403, "output URI does not match deterministic Corvis extraction identity");
  requireAllowedBucket(representation.objectUri);
  return request;
}

async function executeExtraction(request) {
  const representation = request.representation;
  const metadata = await gcsMetadata(representation.objectUri, representation.storageGeneration);
  if (metadata.generation !== representation.storageGeneration) throw new Error("representation generation mismatch");
  const bytes = await gcsDownload(representation.objectUri, representation.storageGeneration);
  if (sha256(bytes) !== representation.contentSha256.toLowerCase()) throw new Error("representation content SHA-256 mismatch");
  const representationText = bytes.toString("utf8");
  const skill = await fetchSkillSnapshot();
  const plan = workUnits(representationText);
  const mapped = await mapConcurrent(skill, plan.units, request);
  const candidates = await reduceCandidates(skill, mapped, request);
  const unresolved = unresolvedAttributionCount(candidates);
  if (unresolved !== 0) throw new Error("global reducer left material candidates without fund attribution");

  const pageNumbers = new Set(plan.units.flatMap((unit) => unit.targetPages));
  const expectedPages = new Set(Array.from({ length: plan.pageCount }, (_, index) => index + 1));
  let unexplainedPageGapCount = 0;
  for (const page of expectedPages) if (!pageNumbers.has(page)) unexplainedPageGapCount += 1;
  if (unexplainedPageGapCount !== 0) throw new Error("orchestration left unexplained page coverage gaps");

  const jsonl = Buffer.from(candidates.map((candidate) => JSON.stringify(candidate)).join("\n") + (candidates.length ? "\n" : ""), "utf8");
  const bundleHash = sha256(jsonl);
  const manifestUri = request.output.objectUri.replace(/\.jsonl$/, ".manifest.json");
  const lineage = modelLineage(PRIMARY_ALIAS);
  const manifest = {
    schema: "corvis.extraction-orchestration-manifest.v1",
    extractionRunId: request.extractionRunId,
    representationId: representation.representationId,
    representationGeneration: representation.storageGeneration,
    representationContentSha256: representation.contentSha256.toLowerCase(),
    skill: { id: SKILL_ID, semanticVersion: SKILL_VERSION, confluencePageId: skill.pageId, confluenceVersion: skill.version },
    orchestrationPolicyVersion: ORCHESTRATION_POLICY_VERSION,
    model: { alias: PRIMARY_ALIAS, verifierAlias: MODEL_MAP[VERIFIER_ALIAS] ? VERIFIER_ALIAS : PRIMARY_ALIAS, provider: lineage.provider, name: lineage.model, version: lineage.version },
    pageCount: plan.pageCount,
    coveredPageCount: pageNumbers.size,
    documentSegmentCount: plan.units.length,
    workUnitCount: plan.units.length,
    unexplainedPageGapCount,
    unresolvedMaterialAttributionCount: unresolved,
    workUnits: plan.units.map((unit) => ({ id: unit.id, kind: unit.kind, targetPages: unit.targetPages, targetSheets: unit.targetSheets })),
    candidateCount: candidates.length,
    candidateBundleSha256: bundleHash,
  };
  const manifestBytes = Buffer.from(`${stableJson(manifest)}\n`, "utf8");
  const manifestHash = sha256(manifestBytes);
  const commonMetadata = {
    "corvis-extraction-run-id": request.extractionRunId,
    "corvis-representation-id": representation.representationId,
    "corvis-representation-generation": representation.storageGeneration,
    "corvis-representation-sha256": representation.contentSha256.toLowerCase(),
    "corvis-skill-id": SKILL_ID,
    "corvis-skill-version": SKILL_VERSION,
    "corvis-schema-version": SCHEMA_VERSION,
    "corvis-orchestration-policy-version": ORCHESTRATION_POLICY_VERSION,
  };
  const manifestObject = await gcsUploadImmutable(manifestUri, manifestBytes, "application/json", {
    ...commonMetadata,
    "corvis-content-sha256": manifestHash,
  });
  const bundleObject = await gcsUploadImmutable(request.output.objectUri, jsonl, "application/x-ndjson", {
    ...commonMetadata,
    "corvis-content-sha256": bundleHash,
    "corvis-orchestration-manifest-uri": manifestUri,
    "corvis-orchestration-manifest-generation": String(manifestObject.generation),
    "corvis-orchestration-manifest-sha256": manifestHash,
  });
  return {
    objectUri: request.output.objectUri,
    storageGeneration: String(bundleObject.generation),
    contentSha256: bundleHash,
    sizeBytes: jsonl.length,
    producer: PRODUCER,
    producerVersion: PRODUCER_VERSION,
    modelProvider: lineage.provider,
    modelName: lineage.model,
    modelVersion: lineage.version,
    orchestrationPolicyVersion: ORCHESTRATION_POLICY_VERSION,
    orchestrationManifest: {
      objectUri: manifestUri,
      storageGeneration: String(manifestObject.generation),
      contentSha256: manifestHash,
      sizeBytes: manifestBytes.length,
      pageCount: plan.pageCount,
      coveredPageCount: pageNumbers.size,
      documentSegmentCount: plan.units.length,
      workUnitCount: plan.units.length,
      unexplainedPageGapCount,
      unresolvedMaterialAttributionCount: unresolved,
    },
  };
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new HttpError(413, "request is too large");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "request body must be valid JSON"); }
}

function respond(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": payload.length, "cache-control": "no-store" });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/healthz") return respond(res, 200, { ok: true });
    if (req.method !== "POST" || req.url !== "/v1/extractions") return respond(res, 404, { error: "not_found" });
    const idempotencyKey = req.headers["x-corvis-idempotency-key"];
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) throw new HttpError(400, "x-corvis-idempotency-key is required");
    const request = validateRequest(await readJsonBody(req));
    const result = await executeExtraction(request);
    return respond(res, 200, result);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "extraction failed";
    console.error(JSON.stringify({ severity: "ERROR", event: "extraction_failed", status, message }));
    return respond(res, status, { error: status >= 500 ? "extraction_failed" : message });
  }
});

server.requestTimeout = 540_000;
server.headersTimeout = 30_000;
server.keepAliveTimeout = 5_000;
server.listen(PORT, "0.0.0.0", () => console.log(JSON.stringify({ severity: "INFO", event: "extractor_started", port: PORT })));
