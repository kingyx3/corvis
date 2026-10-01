import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { downloadText } from "./download.ts";

// The helper only needs a handful of DOM calls, so a recording stub is enough to pin their ordering.
const realDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;
afterEach(() => {
  mock.timers.reset();
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
  if (realDocument) Object.defineProperty(globalThis, "document", realDocument);
  else Reflect.deleteProperty(globalThis, "document");
});

function stubEnvironment(events: string[], clickThrows = false) {
  let attached = false;
  const anchor = {
    href: "", download: "", style: {} as Record<string, string>,
    click() { events.push(`click(attached=${attached})`); if (clickThrows) throw new Error("blocked"); },
    remove() { attached = false; events.push("remove"); },
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => anchor, body: { appendChild: () => { attached = true; events.push("append"); } } },
  });
  URL.createObjectURL = () => "blob:corvis-test";
  URL.revokeObjectURL = (href: string) => { events.push(`revoke(${href})`); };
  return anchor;
}

test("the anchor is attached for the click and the object URL is revoked only on a later tick", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const events: string[] = [];
  const anchor = stubEnvironment(events);
  downloadText("audit.csv", "a,b", "text/csv");
  assert.equal(anchor.href, "blob:corvis-test");
  assert.equal(anchor.download, "audit.csv");
  assert.deepEqual(events, ["append", "click(attached=true)", "remove"], "nothing is revoked synchronously");
  mock.timers.tick(1000);
  assert.deepEqual(events.slice(3), ["revoke(blob:corvis-test)"]);
});

test("a click that throws still detaches the anchor and revokes the URL", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const events: string[] = [];
  stubEnvironment(events, true);
  assert.throws(() => downloadText("audit.csv", "x", "text/csv"), /blocked/);
  mock.timers.tick(1000);
  assert.deepEqual(events, ["append", "click(attached=true)", "remove", "revoke(blob:corvis-test)"]);
});
