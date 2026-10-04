import type { AuditEvent } from "../../core/enterprise.ts";
import { requireTransaction } from "./database.ts";
import { getServerConfig } from "./config.ts";
import { platform } from "./platform.ts";
import { PostgresOperationsRepository } from "./platform-repositories.ts";
import { postgres, type PostgresSqlApi } from "./postgres.ts";

export type AuditedMutationOptions<T> = {
  mutate: (db?: PostgresSqlApi) => Promise<T>;
  /** Return undefined when the command did not mutate state and needs no success audit. */
  audit: (result: T) => AuditEvent | undefined;
  db?: PostgresSqlApi;
  demoMode?: boolean;
};

async function mutateAndAudit<T>(db: PostgresSqlApi, options: AuditedMutationOptions<T>): Promise<T> {
  const result = await options.mutate(db);
  const event = options.audit(result);
  if (event) await new PostgresOperationsRepository(db).audit(event);
  return result;
}

/**
 * Runs a state-changing operation and its required generic audit event in one
 * native database transaction whenever Corvis is using the persistent data
 * plane. A root database handle must provide transactions; otherwise the
 * operation fails closed instead of committing the mutation and audit as
 * separate statements. If the audit insert fails, the mutation rolls back.
 * Commands that decline without mutating may return no audit event. Demo mode
 * preserves the in-memory platform behavior and is deliberately not production
 * evidence.
 *
 * `db` may be the transaction handle supplied by a caller such as
 * `withIdempotency`. Transaction handles deliberately have no nested
 * `transaction` method, so this function joins that existing transaction.
 * A root handle with `transaction` opens exactly one native transaction.
 */
export async function runAuditedMutation<T>(options: AuditedMutationOptions<T>): Promise<T> {
  const config = getServerConfig();
  const demoMode = options.demoMode ?? config.demoMode;
  if (!demoMode) {
    const db = options.db ?? postgres(config.databaseDsn);
    if (db.transaction) {
      return requireTransaction(db, (tx) => mutateAndAudit(tx, options));
    }
    if (options.db) {
      // A caller-supplied handle without `transaction` is an existing native
      // transaction handle. It commits or rolls back with its owner.
      return mutateAndAudit(db, options);
    }
    // The root transport cannot prove mutation/audit atomicity.
    return requireTransaction(db, (tx) => mutateAndAudit(tx, options));
  }

  const result = await options.mutate(undefined);
  const event = options.audit(result);
  if (event) await platform().audit(event);
  return result;
}
