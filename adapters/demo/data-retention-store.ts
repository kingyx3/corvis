import { dataClassLabel, legalHoldScopeLabel, retentionPeriodLabel, type RetentionView } from "../../core/data-retention.ts";
import type { RequestIdentity } from "../../core/enterprise.ts";

/**
 * Retention periods and legal holds for demo mode and the browser suites; not production evidence. Every demo tenant
 * sees the same read-only policy so the view can be exercised without setup: classes on a long fixed period, one
 * kept until the contract ends, one with no fixed period, and one under a legal hold with a matter that covers a few
 * named documents. Nothing here can be changed through the API, exactly as in Postgres.
 */

type Policy = { dataClass: string; days: number | null; deleteOnTermination: boolean; legalHold: boolean; version: string; effectiveFrom: string };
type Hold = { holdId: string; dataClass: string; scope: unknown; matterReference: string; placedAt: string };

const POLICIES: Policy[] = [
  { dataClass: "financials", days: 2555, deleteOnTermination: false, legalHold: false, version: "2026-01", effectiveFrom: "2026-01-01T00:00:00.000Z" },
  { dataClass: "published_data", days: null, deleteOnTermination: true, legalHold: false, version: "2026-01", effectiveFrom: "2026-01-01T00:00:00.000Z" },
  { dataClass: "audit", days: 1825, deleteOnTermination: false, legalHold: false, version: "2026-01", effectiveFrom: "2026-01-01T00:00:00.000Z" },
  { dataClass: "source_documents", days: 3650, deleteOnTermination: false, legalHold: true, version: "2026-03", effectiveFrom: "2026-03-01T00:00:00.000Z" },
];

const HOLDS: Hold[] = [
  {
    holdId: "00000000-0000-4000-8000-0000000000f1",
    dataClass: "source_documents",
    scope: { documentIds: ["demo-document-1", "demo-document-2", "demo-document-3"] },
    matterReference: "MATTER-2026-014",
    placedAt: "2026-04-12T09:30:00.000Z",
  },
];

export class DemoRetentionStore {
  async view(_identity: RequestIdentity): Promise<RetentionView> {
    return {
      policies: POLICIES.map((policy) => ({
        dataClass: policy.dataClass,
        label: dataClassLabel(policy.dataClass),
        retentionDays: policy.days,
        retentionLabel: retentionPeriodLabel(policy.days),
        deleteOnTermination: policy.deleteOnTermination,
        legalHold: policy.legalHold,
        policyVersion: policy.version,
        effectiveFrom: policy.effectiveFrom,
        inEffect: true,
      })),
      legalHolds: HOLDS.map((hold) => ({
        holdId: hold.holdId,
        dataClass: hold.dataClass,
        label: dataClassLabel(hold.dataClass),
        scopeLabel: legalHoldScopeLabel(hold.dataClass, hold.scope),
        matterReference: hold.matterReference,
        placedAt: hold.placedAt,
      })),
    };
  }
}

let singleton: DemoRetentionStore | undefined;
export function demoRetentionStore(): DemoRetentionStore {
  if (!singleton) singleton = new DemoRetentionStore();
  return singleton;
}
