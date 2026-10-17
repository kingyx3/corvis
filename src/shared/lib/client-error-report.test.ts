import assert from "node:assert/strict";
import { test } from "node:test";
import { buildClientErrorEvent, parseClientErrorEvent, reportClientError } from "./client-error-report.ts";

const now = new Date("2026-09-29T00:00:00.000Z");

test("free-text messages, stacks and PII never reach the event", () => {
  const error = new TypeError("Cannot read properties of undefined (reading 'jane.doe@example.com') for Advent International");
  const event = buildClientErrorEvent("view-boundary", error, { view: "review", now });
  assert.deepEqual(event, { event: "corvis.client_error", source: "view-boundary", name: "TypeError", view: "review", occurredAt: now.toISOString() });
  assert.equal(JSON.stringify(event).includes("jane.doe"), false);
});

test("machine-code messages and digests are kept", () => {
  const error = Object.assign(new Error("research_timeout"), { digest: "abc123" });
  const event = buildClientErrorEvent("error-boundary", error, { now });
  assert.equal(event.code, "research_timeout");
  assert.equal(event.digest, "abc123");
});

test("every event the client builds round-trips through the server-side parser", () => {
  for (const event of [
    buildClientErrorEvent("view-boundary", new TypeError("x"), { view: "review", now }),
    buildClientErrorEvent("error-boundary", Object.assign(new Error("research_timeout"), { digest: "abc123" }), { view: "/admin/tenant-health", now }),
    buildClientErrorEvent("unhandled-rejection", "boom", { now }),
  ]) {
    assert.deepEqual(parseClientErrorEvent(JSON.parse(JSON.stringify(event))), event);
  }
});

test("the server-side parser rejects anything that could carry free text", () => {
  const base = buildClientErrorEvent("window-error", new Error("x"), { now });
  for (const value of [null, [], "x", { ...base, stack: "at jane@example.com" }, { ...base, source: "other" }, { ...base, name: "Jane Doe" }, { ...base, code: "Jane's data" }, { ...base, view: "/x?q=secret" }, { ...base, occurredAt: "yesterday" }]) {
    assert.equal(parseClientErrorEvent(value), undefined, JSON.stringify(value));
  }
});

test("non-Error throwables and unsafe error names are normalised", () => {
  assert.equal(buildClientErrorEvent("unhandled-rejection", "boom jane@example.com", { now }).name, "NonError");
  const odd = new Error("x");
  odd.name = "Failure for jane@example.com";
  assert.equal(buildClientErrorEvent("window-error", odd, { now }).name, "NonError");
});


test("the builder and parser exercise safe optional fields and reject every unsafe type", () => {
  const base = buildClientErrorEvent("window-error", new Error("x"), { now });
  const invalidName = new Error("no code");
  invalidName.name = "Name With Spaces";
  assert.equal(buildClientErrorEvent("window-error", invalidName, { now }).name, "NonError");
  assert.equal(buildClientErrorEvent("window-error", undefined, { now }).name, "NonError");
  assert.ok(buildClientErrorEvent("window-error", new Error("x")).occurredAt.endsWith("Z"));

  for (const digest of [23, "in valid", "a".repeat(65), null]) {
    const event = buildClientErrorEvent("window-error", Object.assign(new Error("valid_code"), { digest }), { now });
    assert.equal(event.digest, undefined);
  }
  assert.equal(buildClientErrorEvent("window-error", new Error("unsafe-text"), { now }).code, undefined);
  assert.equal(buildClientErrorEvent("window-error", new Error("ok_code"), { now }).code, "ok_code");

  for (const invalid of [
    {}, { ...base, event: "other" }, { ...base, source: 123 },
    { ...base, name: 1 }, { ...base, name: "!" },
    { ...base, occurredAt: 1 }, { ...base, occurredAt: "x".repeat(41) },
    { ...base, code: 9 }, { ...base, code: "user data" },
    { ...base, digest: 7 }, { ...base, digest: "invalid.digest" },
    { ...base, view: 3 }, { ...base, view: "https://example.test/path" },
  ]) {
    assert.equal(parseClientErrorEvent(invalid), undefined);
  }
  assert.deepEqual(parseClientErrorEvent({ ...base, code: "safe_code", digest: "digest_1", view: "/review" }), {
    ...base, code: "safe_code", digest: "digest_1", view: "/review",
  });
  assert.deepEqual(parseClientErrorEvent(base), base);
});

test("client reporting is best-effort with browser, demo and network fallbacks", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const originalConsoleError = console.error;
  const originalBase = process.env.NEXT_PUBLIC_CORVIS_API_BASE;
  const originalDemo = process.env.NEXT_PUBLIC_CORVIS_DEMO_MODE;
  const requests: { url: string; init: RequestInit }[] = [];
  const reported: unknown[][] = [];
  const setGlobal = (key: "window" | "fetch", value: unknown) => {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  const setWindow = (hash: string, pathname = "/reports") => {
    setGlobal("window", { location: { hash, pathname }, localStorage: { getItem: () => null } });
  };
  try {
    console.error = (...args: unknown[]) => { reported.push(args); };
    process.env.NEXT_PUBLIC_CORVIS_API_BASE = "https://api.example.test/";
    delete process.env.NEXT_PUBLIC_CORVIS_DEMO_MODE;
    setWindow("#/review/queue");
    setGlobal("fetch", (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    const event = reportClientError("view-boundary", new Error("safe_code"));
    assert.equal(event.view, "review");
    assert.equal(reported.length, 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://api.example.test/api/v1/client-errors");
    assert.equal(requests[0].init.method, "POST");
    assert.equal(requests[0].init.credentials, "include");
    assert.equal(requests[0].init.keepalive, true);
    assert.deepEqual(JSON.parse(String(requests[0].init.body)), event);

    setWindow("#invalid/hash", "/fallback");
    assert.equal(reportClientError("window-error", new Error("x")).view, "/fallback");
    assert.equal(reportClientError("window-error", new Error("x"), { view: "/manual" }).view, "/manual");
    assert.equal(requests.length, 3);

    process.env.NEXT_PUBLIC_CORVIS_DEMO_MODE = "true";
    reportClientError("global-error", new Error("x"));
    assert.equal(requests.length, 3);
    delete process.env.NEXT_PUBLIC_CORVIS_DEMO_MODE;

    setGlobal("fetch", undefined);
    reportClientError("global-error", "not an error");
    assert.equal(requests.length, 3);

    setGlobal("window", undefined);
    assert.equal(reportClientError("global-error", new Error("x")).view, undefined);
    assert.equal(requests.length, 3);

    setWindow("#/research");
    setGlobal("fetch", () => { throw new Error("offline"); });
    assert.doesNotThrow(() => reportClientError("window-error", new Error("x")));

    setGlobal("fetch", () => Promise.reject(new Error("offline")));
    assert.doesNotThrow(() => reportClientError("window-error", new Error("x")));
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    console.error = () => { throw new Error("console unavailable"); };
    assert.doesNotThrow(() => reportClientError("window-error", new Error("x")));
  } finally {
    console.error = originalConsoleError;
    for (const [key, original] of [["window", originalWindow], ["fetch", originalFetch]] as const) {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    }
    if (originalBase === undefined) delete process.env.NEXT_PUBLIC_CORVIS_API_BASE;
    else process.env.NEXT_PUBLIC_CORVIS_API_BASE = originalBase;
    if (originalDemo === undefined) delete process.env.NEXT_PUBLIC_CORVIS_DEMO_MODE;
    else process.env.NEXT_PUBLIC_CORVIS_DEMO_MODE = originalDemo;
  }
});
