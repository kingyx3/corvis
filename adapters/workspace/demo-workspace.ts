import type { WorkspacePort } from "@/core/workspace";
import { documents, fundSnapshots, observations } from "@/adapters/demo/catalog";

export function createDemoWorkspacePort(): WorkspacePort {
  return {
    async listDocuments() { return documents; },
    async listObservations() { return observations; },
    async listSnapshots() { return fundSnapshots; },
    async research(question) { return { answer: `Demo response for: ${question}`, citations: [], semanticQueryIds: [], uncertainty: "Demo mode" }; },
    async review() {},
    async publish() {},
  };
}
