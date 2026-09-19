import assert from "node:assert/strict";
import test from "node:test";
import { InvalidCursorError, decodeCursor, encodeCursor, paginate, paginationRequested, parseLimit, type Page } from "./pagination.ts";

type Item = { id: string; label: string };

function items(count: number): Item[] {
  return Array.from({ length: count }, (_, index) => ({ id: `id-${String(index).padStart(4, "0")}`, label: `item ${index}` }));
}

test("encodeCursor/decodeCursor round-trip the sort key exactly", () => {
  const cursor = encodeCursor("id-0007");
  assert.equal(decodeCursor(cursor), "id-0007");
});

test("decodeCursor rejects a tampered or malformed cursor instead of returning a wrong key or crashing", () => {
  assert.throws(() => decodeCursor("not-base64url-json"), InvalidCursorError);
  assert.throws(() => decodeCursor(Buffer.from(JSON.stringify({ v: 1 }), "utf8").toString("base64url")), InvalidCursorError, "missing sort key");
  assert.throws(() => decodeCursor(Buffer.from(JSON.stringify({ v: 2, k: "x" }), "utf8").toString("base64url")), InvalidCursorError, "unsupported schema version");
  assert.throws(() => decodeCursor(Buffer.from(JSON.stringify([1, 2]), "utf8").toString("base64url")), InvalidCursorError, "wrong shape");
  assert.throws(() => decodeCursor(Buffer.from(JSON.stringify({ v: 1, k: "" }), "utf8").toString("base64url")), InvalidCursorError, "empty key");
});

test("parseLimit falls back to the default when absent and rejects a non-positive or non-integer value", () => {
  assert.equal(parseLimit(null), 50);
  assert.equal(parseLimit("25"), 25);
  assert.throws(() => parseLimit("0"), InvalidCursorError);
  assert.throws(() => parseLimit("-5"), InvalidCursorError);
  assert.throws(() => parseLimit("abc"), InvalidCursorError);
  assert.throws(() => parseLimit("3.5"), InvalidCursorError);
});

test("parseLimit caps an oversized request at the maximum rather than rejecting it", () => {
  assert.equal(parseLimit("100000"), 200);
});

test("paginate returns the first page and a cursor for the next one when more items remain", () => {
  const page = paginate(items(10), (item) => item.id, 4);
  assert.equal(page.items.length, 4);
  assert.equal(page.items[0]?.id, "id-0000");
  assert.equal(page.items[3]?.id, "id-0003");
  assert.ok(page.nextCursor);
});

test("walking every page with the returned cursor visits every item exactly once, in order", () => {
  const all = items(23);
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 100; guard += 1) {
    const page: Page<Item> = paginate(all, (item) => item.id, 7, cursor);
    seen.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  assert.deepEqual(seen, all.map((item) => item.id));
});

test("the last page carries no next cursor", () => {
  const page = paginate(items(3), (item) => item.id, 10);
  assert.equal(page.items.length, 3);
  assert.equal(page.nextCursor, null);
});

test("paginationRequested is false for a request with neither limit nor cursor, so an existing caller keeps getting the full list", () => {
  assert.equal(paginationRequested(new URLSearchParams()), false);
  assert.equal(paginationRequested(new URLSearchParams("limit=10")), true);
  assert.equal(paginationRequested(new URLSearchParams("cursor=abc")), true);
});

test("an empty collection returns an empty page with no cursor", () => {
  const page = paginate(items(0), (item) => item.id, 10);
  assert.deepEqual(page.items, []);
  assert.equal(page.nextCursor, null);
});

test("a cursor whose item was deleted since it was issued still resumes correctly from the next surviving item", () => {
  const all = items(10).filter((item) => item.id !== "id-0005");
  // A cursor issued when id-0004 was the last item on a page still works after id-0005 is gone.
  const cursor = encodeCursor("id-0004");
  const page = paginate(all, (item) => item.id, 10, cursor);
  assert.equal(page.items[0]?.id, "id-0006");
});

test("paginate throws on a tampered cursor rather than returning an arbitrary page", () => {
  assert.throws(() => paginate(items(5), (item) => item.id, 10, "garbage-cursor"), InvalidCursorError);
});

test("inserting a new item after a cursor was issued surfaces it on the next page without skipping or duplicating anything already seen", () => {
  const all = items(6);
  const first = paginate(all, (item) => item.id, 3);
  assert.deepEqual(first.items.map((item) => item.id), ["id-0000", "id-0001", "id-0002"]);
  // A new item sorts just after the cursor position.
  const withInsert = [...all, { id: "id-0002-b", label: "inserted" }].sort((a, b) => (a.id < b.id ? -1 : 1));
  const second = paginate(withInsert, (item) => item.id, 3, first.nextCursor);
  assert.deepEqual(second.items.map((item) => item.id), ["id-0002-b", "id-0003", "id-0004"]);
  // Nothing already returned on the first page reappears.
  assert.equal(second.items.some((item) => first.items.some((seen) => seen.id === item.id)), false);
});
