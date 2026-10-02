"use client";

import { useEffect } from "react";
import { useSupportRequest } from "@/components/help/use-support-request";
import { reportClientError } from "@/lib/client-error-report";

// Replaces the root layout when it (or the tree above app/error.tsx) fails, so it must render its
// own document. globals.css is not loaded here, hence the self-contained inline styles; they
// follow the OS color scheme like the built-in error page. "Contact support" is built by the same
// helper as every other entry point (lib/support.ts) and quotes the error digest as the reference.
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    reportClientError("global-error", error);
  }, [error]);
  const support = useSupportRequest({ reference: error.digest });

  return (
    <html lang="en">
      <body style={{ margin: 0, colorScheme: "light dark", fontFamily: "system-ui, sans-serif" }}>
        <title>Corvis — Application error</title>
        <main role="alert" aria-live="assertive" style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: "32px 16px", textAlign: "center" }}>
          <section style={{ maxWidth: 520 }}>
            <h1 style={{ fontSize: 24, margin: "0 0 12px" }}>Corvis couldn’t load.</h1>
            <p style={{ margin: "0 0 20px", lineHeight: 1.5 }}>Your source documents and published data are not changed by this browser error. Retry, and contact support if it persists.</p>
            <button type="button" onClick={() => retry()} style={{ font: "inherit", padding: "8px 18px", cursor: "pointer" }}>Retry</button>
            {" "}
            <a href={support.href} {...(support.opensInNewTab ? { target: "_blank", rel: "noopener noreferrer" } : {})} style={{ font: "inherit", padding: "8px 18px", display: "inline-block", color: "inherit", textDecoration: "underline" }}>Contact support</a>
            {error.digest && <p style={{ fontSize: 12, opacity: 0.7 }}>Reference <code>{error.digest}</code></p>}
          </section>
        </main>
      </body>
    </html>
  );
}
