import type { RequestIdentity } from "../../core/enterprise.ts";
import { dataClassLabel, legalHoldScopeLabel, retentionPeriodLabel, type RetentionView } from "../../core/data-retention.ts";
import { demoCustomerDeletionStore } from "./customer-deletion-store.ts";
import { DEMO_HOLDS, DEMO_POLICIES } from "./data-retention-fixtures.ts";

/**
 * Retention periods, legal holds and deletion requests for demo mode and the browser suites; not production evidence.
 * Every demo tenant sees the same read-only policy so the view can be exercised without setup (`data-retention-fixtures.ts`),
 * and its own deletion requests (`customer-deletion-store.ts`). Nothing here can change a policy or a hold through the API,
 * exactly as in Postgres.
 */
export class DemoRetentionStore {
  async view(identity: RequestIdentity): Promise<RetentionView> {
    return {
      policies: DEMO_POLICIES.map((policy) => ({
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
      legalHolds: DEMO_HOLDS.map((hold) => ({
        holdId: hold.holdId,
        dataClass: hold.dataClass,
        label: dataClassLabel(hold.dataClass),
        scopeLabel: legalHoldScopeLabel(hold.dataClass, hold.scope),
        matterReference: hold.matterReference,
        placedAt: hold.placedAt,
      })),
      deletionRequests: await demoCustomerDeletionStore().list(identity),
    };
  }
}

let singleton: DemoRetentionStore | undefined;
export function demoRetentionStore(): DemoRetentionStore {
  if (!singleton) singleton = new DemoRetentionStore();
  return singleton;
}
