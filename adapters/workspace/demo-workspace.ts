import type { WorkspacePort } from "@/core/workspace";
import { assertDemoModuleAvailable, demoCustomerJourneyStore } from "@/adapters/demo/customer-journey-store";

export function createDemoWorkspacePort(): WorkspacePort {
  return {
    async listDocuments() {
      assertDemoModuleAvailable("documents");
      return demoCustomerJourneyStore.listDocuments();
    },
    async listObservations() {
      assertDemoModuleAvailable("observations");
      return demoCustomerJourneyStore.listObservations();
    },
    async listSnapshots() {
      assertDemoModuleAvailable("snapshots");
      return demoCustomerJourneyStore.listSnapshots();
    },
    async research(question) {
      assertDemoModuleAvailable("research");
      return demoCustomerJourneyStore.research(question);
    },
    async sourceEvidence(sourceReferenceId) {
      return demoCustomerJourneyStore.sourceEvidence(sourceReferenceId);
    },
    async review(command) {
      demoCustomerJourneyStore.review(command);
    },
    async publish(command) {
      demoCustomerJourneyStore.publish(command);
    },
  };
}
