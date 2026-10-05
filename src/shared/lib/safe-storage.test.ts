import assert from "node:assert/strict";
import test from "node:test";
import { safeGetItem, safeRemoveItem, safeSetItem } from "./safe-storage.ts";

function withWindow(value: unknown, run: () => void) {
  const globals = globalThis as Record<string, unknown>;
  const had = "window" in globals;
  const previous = globals.window;
  if (value === undefined) delete globals.window; else globals.window = value;
  try { run(); } finally { if (had) globals.window = previous; else delete globals.window; }
}

test("storage helpers round-trip through the requested storage area", () => {
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  const fake = (map: Map<string, string>) => ({ getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); }, removeItem: (key: string) => { map.delete(key); } });
  withWindow({ localStorage: fake(local), sessionStorage: fake(session) }, () => {
    assert.equal(safeSetItem("session", "k", "v"), true);
    assert.equal(safeGetItem("session", "k"), "v");
    assert.equal(safeGetItem("local", "k"), null);
    safeRemoveItem("session", "k");
    assert.equal(safeGetItem("session", "k"), null);
  });
});

test("storage helpers degrade to no-ops when storage throws or is absent", () => {
  const blocked = { get localStorage(): never { throw new DOMException("blocked", "SecurityError"); }, sessionStorage: { getItem() { throw new Error("denied"); }, setItem() { throw new Error("quota"); }, removeItem() { throw new Error("denied"); } } };
  withWindow(blocked, () => {
    assert.equal(safeGetItem("local", "k"), null);
    assert.equal(safeSetItem("local", "k", "v"), false);
    assert.doesNotThrow(() => safeRemoveItem("local", "k"));
    assert.equal(safeGetItem("session", "k"), null);
    assert.equal(safeSetItem("session", "k", "v"), false);
    assert.doesNotThrow(() => safeRemoveItem("session", "k"));
  });
  withWindow(undefined, () => {
    assert.equal(safeGetItem("local", "k"), null);
    assert.equal(safeSetItem("local", "k", "v"), false);
  });
});
