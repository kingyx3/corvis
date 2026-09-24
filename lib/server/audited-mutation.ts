import type { AuditEvent } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { platform } from "./platform.ts";
import { PostgresOperationsRepository } from "./platform-repositories.ts";
import { postgres, withTransaction, type PostgresSqlApi } from "./postgres.ts";

export type AuditedMutationOptions<T> = {
  mutate: (db?: PostgresSqlApi) => Promise<T>;
  audit: (result: T) => AuditEvent;
  db?: PostgresSqlApi;
  demoMode?: boolean;
};

/**
 * Runs a state-changing operation and its required generic audit event in one
 * Postgres transaction whenever Corvis is using the production data plane.
 * If the audit insert fails, the mutation rolls back. Demo mode preserves the
 * in-memory platform behavior and is deliberately not production evidence.
 */
export async function runAuditedMutation<T>(options: AuditedMutationOptions<T>): Promise<T> {
  const config = getServerConfig();
  const demoMode = options.demoMode ?? config.demoMode;
  if (!demoMode) {
    const db = options.db ?? postgres(config.postgresDsn);
    return withTransaction(db, async (tx) => {
      const result = await options.mutate(tx);
      await new PostgresOperationsRepository(tx).audit(options.audit(result));
      return result;
    });
  }

  const result = await options.mutate(undefined);
  await platform().audit(options.audit(result));
  return result;
}
