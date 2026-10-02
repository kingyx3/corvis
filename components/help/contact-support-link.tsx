"use client";

import type { ReactNode } from "react";
import { useSupportRequest } from "@/components/help/use-support-request";

/**
 * "Contact support" as a plain link, for error states. It is built by the same helper as the Help menu
 * (`lib/support.ts`), so it carries the same pre-filled workspace, view and latest request reference;
 * pass `reference` to quote an error digest.
 */
export function ContactSupportLink({ view, reference, className, children = "Contact support" }: { view?: string; reference?: string; className?: string; children?: ReactNode }) {
  const request = useSupportRequest({ view, reference });
  return <a className={className} href={request.href} {...(request.opensInNewTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{children}</a>;
}
