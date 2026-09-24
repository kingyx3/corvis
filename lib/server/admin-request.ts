/**
 * Reads an admin command body. Only a JSON object is a valid command: a literal
 * `null`, an array, a primitive or malformed JSON yields `undefined` so the
 * route answers 400 instead of throwing a TypeError on the first field access.
 */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | undefined> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return undefined;
  }
  return body !== null && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
}
