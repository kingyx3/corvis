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
  /**
   * Set only when `db` is a transaction handle already owned by the caller
   * (for example `withIdempotency`'s callback handle). Such handles
   * deliberately omit `transaction` so nested callers cannot start another
   * transaction; the mutation and audit join the caller's atomic unit.
   */
  joinExistingTransaction?: boolean;
  /** Test seam. Production is strict by default; non-production compatibility transports are not production evidence. */
  strictTransactions?: boolean;
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
 * plane. Production root database handles must provide transactions; otherwise
 * the operation fails closed instead of committing the mutation and audit as
 * separate statements. If the audit insert fails, the mutation rolls back.
 * Commands that decline without mutating may return no audit event. Demo mode
 * preserves the in-memory platform behavior and is deliberately not production
 * evidence.
 *
 * A caller that already owns the transaction must pass its handle as `db` and
 * set `joinExistingTransaction`. This explicit marker avoids guessing whether
 * a transaction-less adapter is a real transaction handle or a root transport
 * that cannot provide atomicity.
 */
export async function runAuditedMutation<T>(options: AuditedMutationOptions<T>): Promise<T> {
  const config = getServerConfig();
  const demoMode = options.demoMode ?? config.demoMode;
  if (!demoMode) {
    if (options.joinExistingTransaction && !options.db) {
      throw new Error("joinExistingTransaction requires a caller-supplied database handle");
    }
    const db = options.db ?? postgres(config.databaseDsn);
    if (db.transaction) {
      return requireTransaction(db, (tx) => mutateAndAudit(tx, options));
    }
    if (options.joinExistingTransaction) {
      return mutateAndAudit(db, options);
    }
    const strictTransactions = options.strictTransactions ?? config.environment === "production";
    if (strictTransactions) {
      // A root transport without native transactions cannot prove mutation/audit atomicity.
      return requireTransaction(db, (tx) => mutateAndAudit(tx, options));
    }
    // Non-production compatibility transports remain usable by route fakes and
    // local adapters, but are deliberately not accepted as production evidence.
    return mutateAndAudit(db, options);
  }

  const result = await options.mutate(undefined);
  const event = options.audit(result);
  if (event) await platform().audit(event);
  return result;
}
