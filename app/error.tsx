"use client";

import { useEffect } from "react";

export default function ErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("Corvis application error", { message: error.message, digest: error.digest });
  }, [error]);

  return (
    <main className="content" role="alert" aria-live="assertive">
      <section className="page-heading">
        <div>
          <p className="eyebrow">APPLICATION ERROR</p>
          <h1>We couldn’t load this workspace state.</h1>
          <p className="lede">Your source documents and published data are not changed by this browser error. Retry the view, and contact support if it persists.</p>
        </div>
        <button className="primary-button" onClick={reset}>Retry</button>
      </section>
    </main>
  );
}
