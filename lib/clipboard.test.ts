import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { copyToClipboard } from "./clipboard.ts";

const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
afterEach(() => {
  if (original) Object.defineProperty(globalThis, "navigator", original);
  else Reflect.deleteProperty(globalThis, "navigator");
});
function stubNavigator(value: unknown) { Object.defineProperty(globalThis, "navigator", { value, configurable: true }); }

test("resolves true when the clipboard accepts the text", async () => {
  let written = "";
  stubNavigator({ clipboard: { writeText: async (text: string) => { written = text; } } });
  assert.equal(await copyToClipboard("link"), true);
  assert.equal(written, "link");
});

test("resolves false when writeText throws synchronously", async () => {
  stubNavigator({ clipboard: { writeText: () => { throw new Error("NotAllowedError"); } } });
  assert.equal(await copyToClipboard("link"), false);
});

test("resolves false when writeText rejects or the clipboard API is missing", async () => {
  stubNavigator({ clipboard: { writeText: () => Promise.reject(new Error("denied")) } });
  assert.equal(await copyToClipboard("link"), false);
  stubNavigator({});
  assert.equal(await copyToClipboard("link"), false);
});
