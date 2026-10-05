/**
 * The demo organizations' retention policies and legal holds, shared by the retention view and the deletion requests that
 * must respect them (`data-retention-store.ts`, `customer-deletion-store.ts`). Every demo tenant has the same read-only
 * policy: classes on a long fixed period, one kept until the contract ends, one with no fixed period, and one under a
 * legal hold with a matter that covers a few named documents. Demo mode and the browser suites only; not production evidence.
 */

export type DemoPolicy = { dataClass: string; days: number | null; deleteOnTermination: boolean; legalHold: boolean; version: string; effectiveFrom: string };
export type DemoHold = { holdId: string; dataClass: string; scope: unknown; matterReference: string; placedAt: string };

export const DEMO_POLICIES: readonly DemoPolicy[] = [
  { dataClass: "financials", days: 2555, deleteOnTermination: false, legalHold: false, version: "2026-01", effectiveFrom: "2026-01-01T00:00:00.000Z" },
  { dataClass: "published_data", days: null, deleteOnTermination: true, legalHold: false, version: "2026-01", effectiveFrom: "2026-01-01T00:00:00.000Z" },
  { dataClass: "audit", days: 1825, deleteOnTermination: false, legalHold: false, version: "2026-01", effectiveFrom: "2026-01-01T00:00:00.000Z" },
  { dataClass: "source_documents", days: 3650, deleteOnTermination: false, legalHold: true, version: "2026-03", effectiveFrom: "2026-03-01T00:00:00.000Z" },
];

export const DEMO_HOLDS: readonly DemoHold[] = [
  {
    holdId: "00000000-0000-4000-8000-0000000000f1",
    dataClass: "source_documents",
    scope: { documentIds: ["demo-document-1", "demo-document-2", "demo-document-3"] },
    matterReference: "MATTER-2026-014",
    placedAt: "2026-04-12T09:30:00.000Z",
  },
];

/** True when a hold on any of the classes (the policy flag or a placed hold) stops a deletion that covers it. */
export function demoLegalHoldCovers(dataClasses: readonly string[]): boolean {
  return dataClasses.some((dataClass) => DEMO_POLICIES.some((policy) => policy.dataClass === dataClass && policy.legalHold)
    || DEMO_HOLDS.some((hold) => hold.dataClass === dataClass));
}

/** True when every class has a retention policy (the demo policies are all in effect). */
export function demoRetentionCovers(dataClasses: readonly string[]): boolean {
  return dataClasses.every((dataClass) => DEMO_POLICIES.some((policy) => policy.dataClass === dataClass));
}
