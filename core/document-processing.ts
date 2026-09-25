import type { DocumentRecord } from "./contracts";

export type DocumentSecurityNotice = {
  label: string;
  detail: string;
  action: string;
};

const SECURITY_FAILURE_STATES = new Set(["quarantined", "quarantine", "rejected", "malware", "malware_detected", "security_rejected"]);

/** Customer-safe copy for security-scan failures. Raw pipeline enums must never be rendered. */
export function documentSecurityNotice(document: Pick<DocumentRecord, "processingState">): DocumentSecurityNotice | null {
  const state = document.processingState?.trim().toLowerCase();
  if (!state || !SECURITY_FAILURE_STATES.has(state)) return null;

  if (state === "malware" || state === "malware_detected" || state === "security_rejected") {
    return {
      label: "Security check failed",
      detail: "This file did not pass Corvis security checks and will not be processed.",
      action: "Verify the source file is safe, then upload a clean copy.",
    };
  }

  return {
    label: "File not processed",
    detail: "This file was stopped by a security or validation check and will not continue through processing.",
    action: "Review the source file and upload a corrected copy. Contact support if the file is expected to be valid.",
  };
}
