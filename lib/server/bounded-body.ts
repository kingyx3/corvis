/** Raised when a request body exceeds the caller's byte limit, before or while it is read. */
export class RequestBodyTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`request body exceeds ${maxBytes} bytes`);
    this.name = "RequestBodyTooLargeError";
    this.maxBytes = maxBytes;
  }
}

/**
 * Reads a request body as UTF-8 text without ever buffering more than `maxBytes`. A declared
 * `Content-Length` over the limit is rejected before the body is touched; otherwise (no length, a
 * chunked body, or a length that understates the body) the stream is read with a running byte count
 * and cancelled the moment it passes the limit. `request.text()` buffers the whole body first, so a
 * size check after it does not bound memory.
 */
export async function readBoundedRequestText(request: Request, maxBytes: number): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > maxBytes) throw new RequestBodyTooLargeError(maxBytes);
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RequestBodyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
