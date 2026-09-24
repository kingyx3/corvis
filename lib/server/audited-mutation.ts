import type { AuditEvent } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { platform } from "./platform.ts";
import { PostgresOperationsRepository } from "./platform-repositories.ts";
import { postgres, withTransaction, type PostgresSqlApi } from "./postgres.ts";

export type AuditedMutationOptions<T> = {
  mutate: (db?: PostgresSqlApi) => Promise<T>;
  /** Return undefined when the command did not mutate state and needs no success audit. */
  audit: (result: T) => AuditEvent | undefined;
  db?: PostgresSqlApi;
  demoMode?: boolean;
};

/**
 * Runs a state-changing operation and its required generic audit event in one
 * Postgres transaction whenever Corvis is using the production data plane.
 * If the audit insert fails, the mutation rolls back. Commands that decline
 * without mutating may return no audit event. Demo mode preserves the
 * in-memory platform behavior and is deliberately not production evidence.
 */
export async function runAuditedMutation<T>(options: AuditedMutationOptions<T>): Promise<T> {
  const config = getServerConfig();
  const demoMode = options.demoMode ?? config.demoMode;
  if (!demoMode) {
    const db = options.db ?? postgres(config.postgresDsn);
    return withTransaction(db, async (tx) => {
      const result = await options.mutate(tx);
      const event = options.audit(result);
      if (event) await new PostgresOperationsRepository(tx).audit(event);
      return result;
    });
  }

  const result = await options.mutate(undefined);
  const event = options.audit(result);
  if (event) await platform().audit(event);
  return result;
}
