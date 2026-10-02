"use client";

import { useEffect } from "react";
import { catchError, type ErrorInfo } from "next/error";
import { reportClientError } from "@/lib/client-error-report";
import { ContactSupportLink } from "@/components/help/contact-support-link";
import { PageHeading } from "@/components/ui/page-heading";

function ViewErrorFallback({ label, view }: { label: string; view: string }, { error, retry }: ErrorInfo) {
  useEffect(() => { reportClientError("view-boundary", error, { view }); }, [error, view]);
  const digest = (error as { digest?: unknown } | null)?.digest;
  const reference = typeof digest === "string" ? digest : undefined;
  return <div role="alert" data-testid="view-error">
    <PageHeading eyebrow="View error" title={`${label} couldn’t be displayed`} description="The rest of the workspace is unaffected, and your source documents and published data are not changed. Retry this view, or choose another section from the navigation.">
      <button type="button" className="secondary-button" onClick={() => retry()}>Retry this view</button>
      <ContactSupportLink className="text-button" view={view} reference={reference}/>
      {reference && <p className="field-hint">Reference <code>{reference}</code></p>}
    </PageHeading>
  </div>;
}

/**
 * Isolates one workspace view: a render error inside it shows this fallback while the sidebar,
 * top bar and every other view stay usable. Mount it with `key={view}` so switching views resets it.
 */
export const ViewErrorBoundary = catchError(ViewErrorFallback);
