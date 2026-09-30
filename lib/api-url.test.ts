import assert from "node:assert/strict";
import test from "node:test";
import { apiBase, apiUrl } from "./api-url.ts";

test("apiUrl is same-origin when no API base is configured", () => {
  const previous = process.env.NEXT_PUBLIC_CORVIS_API_BASE;
  try {
    delete process.env.NEXT_PUBLIC_CORVIS_API_BASE;
    assert.equal(apiBase(), "");
    assert.equal(apiUrl("/api/v1/portfolios?limit=100"), "/api/v1/portfolios?limit=100");
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_CORVIS_API_BASE; else process.env.NEXT_PUBLIC_CORVIS_API_BASE = previous;
  }
});

test("apiUrl prefixes a cross-origin API base and tolerates a trailing slash", () => {
  const previous = process.env.NEXT_PUBLIC_CORVIS_API_BASE;
  try {
    process.env.NEXT_PUBLIC_CORVIS_API_BASE = "https://api.corvis.test/";
    assert.equal(apiBase(), "https://api.corvis.test");
    assert.equal(apiUrl("/api/v1/workspace-preferences"), "https://api.corvis.test/api/v1/workspace-preferences");
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_CORVIS_API_BASE; else process.env.NEXT_PUBLIC_CORVIS_API_BASE = previous;
  }
});
