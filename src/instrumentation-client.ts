// Runs in the browser before hydration (Next.js instrumentation-client). Captures errors that no
// React error boundary sees (event handlers, async callbacks, unhandled rejections) and reports
// them as structured, PII-free events; see src/lib/client-error-report.ts.
import { reportClientError } from "./lib/client-error-report.ts";

function isAbort(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === "AbortError";
}

try {
  window.addEventListener("error", (event) => {
    reportClientError("window-error", event.error);
  });
  window.addEventListener("unhandledrejection", (event) => {
    // Cancelled requests reject with AbortError by design; they are not failures.
    if (!isAbort(event.reason)) reportClientError("unhandled-rejection", event.reason);
  });
} catch {
  // Instrumentation must never prevent the app from starting.
}
