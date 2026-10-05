"use client";

import Link from "next/link";
import { useEffect } from "react";
import { ContactSupportLink } from "@/modules/support/ui/contact-support-link";
import { reportClientError } from "@/shared/lib/client-error-report";

export default function ErrorBoundary({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    reportClientError("error-boundary", error);
  }, [error]);

  return (
    <main className="state-page" role="alert" aria-live="assertive">
      <section className="state-card">
        <span className="brand-mark" aria-hidden="true">C</span>
        <p className="eyebrow">Application error</p>
        <h1>We couldn’t load this workspace state.</h1>
        <p className="lede">Your source documents and published data are not changed by this browser error. Retry the view, and contact support if it persists.</p>
        <div className="state-actions">
          <button className="primary-button" onClick={() => retry()}>Retry</button>
          <Link className="secondary-button" href="/">Return to workspace</Link>
          <ContactSupportLink className="secondary-button" reference={error.digest}/>
        </div>
        {error.digest && <p className="field-hint state-reference">Reference <code>{error.digest}</code></p>}
      </section>
    </main>
  );
}
