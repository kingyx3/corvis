import { randomUUID } from "crypto";
import { documents, fundSnapshots, observations } from "@/adapters/demo/catalog";
import type { AuditEvent, ExportManifest, ProcessingJob, RequestIdentity, ResearchAnswer, ReviewDecision, SnapshotPublication } from "@/core/enterprise";
import { getServerConfig } from "@/lib/server/config";

export interface PlatformPort {
  listDocuments(identity: RequestIdentity): Promise<typeof documents>;
  listObservations(identity: RequestIdentity): Promise<typeof observations>;
  listSnapshots(identity: RequestIdentity): Promise<typeof fundSnapshots>;
  review(identity: RequestIdentity, decision: ReviewDecision): Promise<{ accepted: true; reviewEventId: string }>;
  publish(identity: RequestIdentity, command: SnapshotPublication): Promise<{ accepted: true; publicationEventId: string }>;
  research(identity: RequestIdentity, question: string): Promise<ResearchAnswer>;
  audit(event: AuditEvent): Promise<void>;
  readiness(): Promise<Record<string, "configured" | "missing" | "demo">>;
  export(identity: RequestIdentity, format: ExportManifest["format"]): Promise<ExportManifest>;
  jobs(identity: RequestIdentity): Promise<ProcessingJob[]>;
}

class DemoPlatform implements PlatformPort {
  private auditEvents: AuditEvent[] = [];
  async listDocuments() { return documents; }
  async listObservations() { return observations; }
  async listSnapshots() { return fundSnapshots; }
  async review(identity: RequestIdentity, decision: ReviewDecision) {
    void identity; void decision;
    return { accepted: true as const, reviewEventId: randomUUID() };
  }
  async publish(identity: RequestIdentity, command: SnapshotPublication) {
    void identity; void command;
    return { accepted: true as const, publicationEventId: randomUUID() };
  }
  async research(identity: RequestIdentity, question: string): Promise<ResearchAnswer> {
    void identity;
    return {
      answer: `Demo-mode response for: ${question}. Production requires the semantic-query and permissioned-retrieval adapters.`,
      citations: [], semanticQueryIds: [], uncertainty: "Demo mode does not execute production semantic queries.",
    };
  }
  async audit(event: AuditEvent) { this.auditEvents.push(event); }
  async readiness() { return { identity: "demo", objectStore: "demo", snowflake: "demo", orchestration: "demo", retrieval: "demo", observability: "demo" } as const; }
  async export(identity: RequestIdentity, format: ExportManifest["format"]): Promise<ExportManifest> {
    return { exportId: randomUUID(), tenantId: identity.tenantId, generatedAt: new Date().toISOString(), schemaVersion: "v1", taxonomyVersion: "v1", snapshotIds: [], format, rowCounts: {}, checksumSha256: "demo" };
  }
  async jobs() { return []; }
}

class UnboundProductionPlatform implements PlatformPort {
  private fail(): never { throw new Error("Production platform adapter is not bound. Configure approved Snowflake/object-store/orchestration/retrieval adapters before deployment."); }
  async listDocuments(): Promise<typeof documents> { return this.fail(); }
  async listObservations(): Promise<typeof observations> { return this.fail(); }
  async listSnapshots(): Promise<typeof fundSnapshots> { return this.fail(); }
  async review(): Promise<{ accepted: true; reviewEventId: string }> { return this.fail(); }
  async publish(): Promise<{ accepted: true; publicationEventId: string }> { return this.fail(); }
  async research(): Promise<ResearchAnswer> { return this.fail(); }
  async audit(): Promise<void> { return this.fail(); }
  async readiness() { const c = getServerConfig(); return { identity: c.authIssuer ? "configured" : "missing", objectStore: c.objectStoreBucket ? "configured" : "missing", snowflake: c.snowflakeDsn ? "configured" : "missing", orchestration: "missing", retrieval: c.searchEndpoint ? "configured" : "missing", observability: "missing" } as Record<string,"configured"|"missing"|"demo">; }
  async export(): Promise<ExportManifest> { return this.fail(); }
  async jobs(): Promise<ProcessingJob[]> { return this.fail(); }
}

let singleton: PlatformPort | undefined;
export function platform(): PlatformPort {
  if (!singleton) singleton = getServerConfig().demoMode ? new DemoPlatform() : new UnboundProductionPlatform();
  return singleton;
}
