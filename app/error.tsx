"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function ErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("Corvis application error", { message: error.message, digest: error.digest });
  }, [error]);

  return (
    <main className="state-page" role="alert" aria-live="assertive">
      <section className="state-card">
        <span className="brand-mark" aria-hidden="true">C</span>
        <p className="eyebrow">Application error</p>
        <h1>We couldn’t load this workspace state.</h1>
        <p className="lede">Your source documents and published data are not changed by this browser error. Retry the view, and contact support if it persists.</p>
        <div className="state-actions">
          <button className="primary-button" onClick={reset}>Retry</button>
          <Link className="secondary-button" href="/">Return to workspace</Link>
        </div>
        {error.digest && <p className="field-hint state-reference">Reference <code>{error.digest}</code></p>}
      </section>
    </main>
  );
}
