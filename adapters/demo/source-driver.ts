import type { ConnectorDriver, RemoteDocumentRef, SourceScope } from "../../lib/server/source-connectors.ts";

/**
 * The connector driver behind the demonstration providers (adapters/demo/source-providers.ts), used only in demo mode.
 * It contacts nothing: each in-scope folder "contains" two fixed demonstration PDFs, so scheduled collection can be
 * exercised end to end (discovery inside the confirmed scope, download, the upload pipeline, run history) and a second
 * run finds the same two documents already collected. It is not a driver for any real vendor, and none exists yet.
 */

const DOCUMENTS = [
  { name: "Quarterly-report-2026-Q2.pdf", key: "quarterly-report" },
  { name: "Capital-account-statement-2026-Q2.pdf", key: "capital-account-statement" },
] as const;

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "folder";
}

function folderOf(scope: SourceScope): string {
  return scope.path ?? `/${slug(scope.label)}`;
}

export function demoConnectorDriver(providerKey: string): ConnectorDriver {
  return {
    providerKey,
    connectorVersion: "demo-1",
    async testConnection() { return { ok: true }; },
    async discover(_credential, scope): Promise<RemoteDocumentRef[]> {
      return scope.flatMap((entry) => DOCUMENTS.map((document) => ({
        remoteDocumentId: `${providerKey}:${slug(folderOf(entry))}:${document.key}`,
        remoteVersion: "v1",
        remotePath: `${folderOf(entry).replace(/\/+$/, "")}/${document.name}`,
      })));
    },
    async download(_credential, ref) {
      const body = `%PDF-1.4\n% Corvis demonstration document. Not real fund data.\n% ${ref.remoteDocumentId} ${ref.remoteVersion}\n%%EOF\n`;
      return { bytes: Buffer.from(body, "utf8"), contentType: "application/pdf" };
    },
  };
}
