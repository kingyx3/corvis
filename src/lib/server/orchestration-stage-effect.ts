import type { ProcessingStage } from "@/core/enterprise";
import type { PostgresSqlApi } from "./postgres.ts";

export type ProcessingStageEffectClaim = {
  shouldExecute: boolean;
  alreadyComplete: boolean;
  attempt: number;
};

function bool(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class PostgresProcessingStageEffectRepository {
  private readonly db: PostgresSqlApi;

  constructor(db: PostgresSqlApi) {
    this.db = db;
  }

  async begin(input: {
    tenantId: string;
    jobId: string;
    effectKey: string;
    documentId: string;
    stage: ProcessingStage;
  }): Promise<ProcessingStageEffectClaim> {
    const rows = await this.db.query(`select * from corvis_control.begin_processing_stage_effect(
      $1::uuid,$2,$3,$4::uuid,$5)`, [
      input.tenantId,input.jobId,input.effectKey,input.documentId,input.stage,
    ]);
    const row = rows[0] ?? {};
    return {
      shouldExecute: bool(row.should_execute),
      alreadyComplete: bool(row.already_complete),
      attempt: number(row.effect_attempt),
    };
  }

  async complete(input: {
    tenantId: string;
    jobId: string;
    effectKey: string;
    result?: Record<string, unknown>;
  }): Promise<boolean> {
    const rows = await this.db.query(`select corvis_control.complete_processing_stage_effect(
      $1::uuid,$2,$3,$4::jsonb) as completed`, [
      input.tenantId,input.jobId,input.effectKey,JSON.stringify(input.result ?? {}),
    ]);
    return bool(rows[0]?.completed);
  }
}
