import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

const baseEnv = {
  ...process.env,
  CORVIS_LITELLM_URL: "http://127.0.0.1:9",
  LITELLM_MASTER_KEY: "test-only",
  CORVIS_OBJECT_STORE_BUCKET: "test-bucket",
  CORVIS_LITELLM_MODELS_JSON: JSON.stringify({
    "corvis-extract-primary": "test/model",
    "corvis-extract-verifier": "test/verifier",
    "corvis-extract-custom": "test/custom",
  }),
  PORT: "0",
};
Object.assign(process.env, baseEnv);
const { server, fetchBounded, normalizeCandidate, mapPrompt } = await import("./server.mjs");
await once(server, "listening");
const port = server.address().port;
test.after(() => server.close());

const reference = () => ({
  referenceKey: "ref-1", pageNumber: 1, documentSegmentId: "segment-1",
  workUnitId: "wu-0001", fundContextIds: [], pageCoverageState: "primary",
  extractionMethod: "native_text",
});
const candidate = () => ({
  candidateKey: "candidate-1", candidateType: "exception", payload: {},
  confidence: { extraction: 0.9 }, provenance: {}, sourceReferences: [reference()],
});

async function upstream(handler, fn) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test("EXT-01 valid default configuration starts and serves health", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});
test("EXT-02 custom primary alias is actually used during startup validation", async () => {
  const x = await launch({ CORVIS_EXTRACTION_MODEL: "corvis-extract-custom", CORVIS_LITELLM_MODELS_JSON: JSON.stringify({ "corvis-extract-primary": "test/model" }) });
  assert.notEqual(x.code, 0);
  assert.match(x.logs, /primary extraction alias corvis-extract-custom/);
});
async function launch(overrides) {
  const child = spawn(process.execPath, ["services/extractor/server.mjs"], {
    env: { ...baseEnv, ...overrides }, stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stderr.on("data", x => { logs += x.toString(); });
  const [code] = await once(child, "exit");
  return { code, logs };
}
test("EXT-03 missing primary alias fails before listen", async () => {
  const x = await launch({ CORVIS_LITELLM_MODELS_JSON: '{"corvis-extract-verifier":"test/model"}' });
  assert.notEqual(x.code, 0);
  assert.match(x.logs, /primary extraction alias/);
});
test("EXT-04 malformed configuration fails before listen", async () => {
  for (const value of ["{bad", "[]", "{}"]) {
    const x = await launch({ CORVIS_LITELLM_MODELS_JSON: value });
    assert.notEqual(x.code, 0);
  }
});
test("BND-01 stalled response body is aborted after headers", async () => {
  await upstream((req,res) => { res.writeHead(200); res.write("start"); }, async url => {
    const start = Date.now();
    await assert.rejects(async () => (await fetchBounded(url, {}, 100)).text());
    assert.ok(Date.now() - start < 2000);
  });
});
test("BND-02 trickling chunks cannot extend absolute deadline", async () => {
  await upstream((req,res) => {
    res.writeHead(200);
    const interval = setInterval(() => res.write("x"), 15);
    res.on("close", () => clearInterval(interval));
  }, async url => {
    await assert.rejects(async () => (await fetchBounded(url, {}, 110)).text());
  });
});
test("BND-03 chunked response is rejected before full buffering", async () => {
  await upstream((req,res) => { res.writeHead(200); res.write("1234"); res.end("5678"); }, async url => {
    await assert.rejects(async () => (await fetchBounded(url)).readBoundedBytes(5), /size limit/);
  });
});
test("BND-04 declared oversize is rejected", async () => {
  await upstream((req,res) => { res.writeHead(200, { "content-length": "100000" }); res.write("x"); }, async url => {
    await assert.rejects(async () => (await fetchBounded(url)).readBoundedBytes(5), /size limit/);
  });
});
test("BND-05 exact limit succeeds", async () => {
  await upstream((req,res) => res.end("12345"), async url => {
    assert.equal((await (await fetchBounded(url)).readBoundedBytes(5)).toString(), "12345");
  });
});
test("BND-06 truncated response fails instead of hanging", async () => {
  await upstream((req,res) => { res.writeHead(200, { "content-length": "100" }); res.write("x"); res.destroy(); }, async url => {
    await assert.rejects(async () => (await fetchBounded(url, {}, 150)).text());
  });
});
test("REF-01 valid reference passes producer validation", () => {
  assert.equal(normalizeCandidate(candidate()).sourceReferences[0].referenceKey, "ref-1");
});
test("REF-02 missing key rejected at producer", () => {
  const c = candidate(); delete c.sourceReferences[0].referenceKey;
  assert.throws(() => normalizeCandidate(c), /referenceKey/);
});
test("REF-03 malformed keys rejected", () => {
  for (const value of [null, "", " ", 42, {}]) {
    const c = candidate(); c.sourceReferences[0].referenceKey = value;
    assert.throws(() => normalizeCandidate(c), /referenceKey/);
  }
});
test("REF-04 multiple references retain stable keys", () => {
  const c = candidate(); c.sourceReferences.push({ ...reference(), referenceKey: "ref-2" });
  assert.deepEqual(normalizeCandidate(c).sourceReferences.map(r => r.referenceKey), ["ref-1", "ref-2"]);
});
test("REF-05 prompt requests the downstream reference key", () => {
  const prompt = mapPrompt({ pageId: "1", version: "1", content: "test" },
    { id: "wu-0001", kind: "pages", targetPages: [1], source: "{}" }, { extractionRunId: "run-1" });
  assert.match(prompt, /referenceKey/);
});

test("REF-06 duplicate reference keys are rejected before downstream ID derivation", () => {
  const c = candidate();
  c.sourceReferences.push({ ...reference(), pageNumber: 2 });
  assert.throws(() => normalizeCandidate(c), /duplicate referenceKey/);
});
