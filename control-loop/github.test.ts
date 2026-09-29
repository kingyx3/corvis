import assert from "node:assert/strict";
import test from "node:test";
import { createGitHubIssueWriter, fetchIssueSnapshot } from "./github.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("fetchIssueSnapshot reads open/closed control-loop issues and extracts their fingerprint", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    calls.push(String(input));
    return jsonResponse([
      { number: 1, state: "open", title: "a", body: "Finding fingerprint: `x:y:z`", labels: [{ name: "control-loop" }] },
      { number: 2, state: "closed", title: "b", body: "no fingerprint here", labels: ["control-loop"] },
      { number: 3, state: "open", title: "pr", body: null, labels: [], pull_request: {} },
    ]);
  };
  const snapshot = await fetchIssueSnapshot({ owner: "kingyx3", repo: "corvis", fetchImpl });
  assert.equal(snapshot?.issues.length, 2, "pull requests are excluded");
  assert.deepEqual(snapshot?.issues[0], { number: 1, state: "open", title: "a", fingerprint: "x:y:z", labels: ["control-loop"] });
  assert.equal(snapshot?.issues[1]?.fingerprint, null);
  assert.ok(calls[0]?.includes("labels=control-loop"));
});

test("fetchIssueSnapshot degrades to null rather than throwing on a failed request", async () => {
  const fetchImpl: typeof fetch = async () => new Response("", { status: 500 });
  assert.equal(await fetchIssueSnapshot({ owner: "o", repo: "r", fetchImpl }), null);
});

test("createGitHubIssueWriter.create posts title/body/labels and returns the issue number", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init as RequestInit });
    return jsonResponse({ number: 99 });
  };
  const writer = createGitHubIssueWriter({ owner: "o", repo: "r", token: "tok", fetchImpl });
  const created = await writer.create({ title: "t", body: "b", labels: ["control-loop"] });
  assert.deepEqual(created, { number: 99 });
  assert.equal(calls[0]?.url, "https://api.github.com/repos/o/r/issues");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(new Headers(calls[0]?.init.headers).get("authorization"), "Bearer tok");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { title: "t", body: "b", labels: ["control-loop"] });
});

test("createGitHubIssueWriter.setState PATCHes the issue state", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init as RequestInit });
    return new Response("{}", { status: 200 });
  };
  const writer = createGitHubIssueWriter({ owner: "o", repo: "r", token: "tok", fetchImpl });
  await writer.setState(5, "closed");
  assert.equal(calls[0]?.url, "https://api.github.com/repos/o/r/issues/5");
  assert.equal(calls[0]?.init.method, "PATCH");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { state: "closed" });
});

test("createGitHubIssueWriter.comment POSTs to the issue's comments endpoint", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init as RequestInit });
    return new Response("{}", { status: 201 });
  };
  const writer = createGitHubIssueWriter({ owner: "o", repo: "r", token: "tok", fetchImpl });
  await writer.comment(5, "hello");
  assert.equal(calls[0]?.url, "https://api.github.com/repos/o/r/issues/5/comments");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { body: "hello" });
});

test("createGitHubIssueWriter surfaces a non-ok response as a thrown error rather than swallowing the failure", async () => {
  const fetchImpl: typeof fetch = async () => new Response("", { status: 403 });
  const writer = createGitHubIssueWriter({ owner: "o", repo: "r", token: "tok", fetchImpl });
  await assert.rejects(() => writer.create({ title: "t", body: "b", labels: [] }), /github_issue_create_failed:403/);
  await assert.rejects(() => writer.setState(1, "open"), /github_issue_set_state_failed:403/);
  await assert.rejects(() => writer.comment(1, "x"), /github_issue_comment_failed:403/);
});

function pageOfIssues(count: number, offset = 0): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    number: offset + index + 1,
    state: "open",
    title: `issue ${offset + index + 1}`,
    body: null,
    labels: ["control-loop"],
  }));
}

test("fetchIssueSnapshot gives every request an abort signal", async () => {
  const signals: Array<AbortSignal | null | undefined> = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    signals.push(init?.signal);
    return jsonResponse([]);
  };
  await fetchIssueSnapshot({ owner: "o", repo: "r", fetchImpl });
  assert.equal(signals.length, 1);
  assert.ok(signals[0] instanceof AbortSignal);
});

// AbortSignal.timeout timers are unref'd; a real hung socket keeps the process alive, a mock does not.
async function withEventLoopKeptAlive<T>(body: () => Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => undefined, 1_000);
  try {
    return await body();
  } finally {
    clearInterval(keepAlive);
  }
}

test("fetchIssueSnapshot degrades to null when a request hangs past the timeout", async () => {
  const fetchImpl: typeof fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  const snapshot = await withEventLoopKeptAlive(() => fetchIssueSnapshot({ owner: "o", repo: "r", fetchImpl, timeoutMs: 20 }));
  assert.equal(snapshot, null);
});

test("fetchIssueSnapshot pages through a full page and returns the complete snapshot when the last page is short", async () => {
  const pages: number[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const page = Number(new URL(String(input)).searchParams.get("page"));
    pages.push(page);
    return jsonResponse(page === 1 ? pageOfIssues(100) : pageOfIssues(3, 100));
  };
  const snapshot = await fetchIssueSnapshot({ owner: "o", repo: "r", fetchImpl });
  assert.deepEqual(pages, [1, 2]);
  assert.equal(snapshot?.issues.length, 103);
});

test("fetchIssueSnapshot fails closed instead of truncating when the page cap is reached", async () => {
  const pages: number[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const page = Number(new URL(String(input)).searchParams.get("page"));
    pages.push(page);
    return jsonResponse(pageOfIssues(100, (page - 1) * 100));
  };
  assert.equal(await fetchIssueSnapshot({ owner: "o", repo: "r", fetchImpl, maxPages: 3 }), null);
  assert.deepEqual(pages, [1, 2, 3]);
  // Default cap of 20 pages.
  pages.length = 0;
  assert.equal(await fetchIssueSnapshot({ owner: "o", repo: "r", fetchImpl }), null);
  assert.equal(pages.length, 20);
});

test("fetchIssueSnapshot still succeeds when the final allowed page is short", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const page = Number(new URL(String(input)).searchParams.get("page"));
    return jsonResponse(page < 3 ? pageOfIssues(100, (page - 1) * 100) : pageOfIssues(5, 200));
  };
  const snapshot = await fetchIssueSnapshot({ owner: "o", repo: "r", fetchImpl, maxPages: 3 });
  assert.equal(snapshot?.issues.length, 205);
});

test("createGitHubIssueWriter gives every mutating request an abort signal and rejects on timeout", async () => {
  const signals: Array<AbortSignal | null | undefined> = [];
  const okFetch: typeof fetch = async (_input, init) => {
    signals.push(init?.signal);
    return jsonResponse({ number: 1 });
  };
  const writer = createGitHubIssueWriter({ owner: "o", repo: "r", token: "tok", fetchImpl: okFetch });
  await writer.create({ title: "t", body: "b", labels: [] });
  await writer.setState(1, "closed");
  await writer.comment(1, "x");
  assert.equal(signals.length, 3);
  assert.ok(signals.every((signal) => signal instanceof AbortSignal));

  const hangingFetch: typeof fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  const hanging = createGitHubIssueWriter({ owner: "o", repo: "r", token: "tok", fetchImpl: hangingFetch, timeoutMs: 20 });
  await withEventLoopKeptAlive(() => assert.rejects(() => hanging.comment(1, "x")));
});
