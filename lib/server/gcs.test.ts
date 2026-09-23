import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { deleteWithZeroContentLength } from "./gcs.ts";

test("resumable-session cancellation sends DELETE with Content-Length: 0 and no bearer token", async () => {
  const seen: { method?: string; headers?: IncomingHttpHeaders }[] = [];
  const server = createServer((request, response) => {
    seen.push({ method: request.method, headers: request.headers });
    response.statusCode = 499;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const status = await deleteWithZeroContentLength(
      `http://127.0.0.1:${port}/upload/storage/v1/b/bucket/o?uploadType=resumable&upload_id=abc`,
      httpRequest as unknown as typeof httpsRequest,
    );
    assert.equal(status, 499);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.method, "DELETE");
    assert.equal(seen[0]?.headers?.["content-length"], "0");
    assert.equal(seen[0]?.headers?.authorization, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("resumable-session cancellation surfaces transport failures", async () => {
  await assert.rejects(deleteWithZeroContentLength("http://127.0.0.1:1/cancel", httpRequest as unknown as typeof httpsRequest));
});
