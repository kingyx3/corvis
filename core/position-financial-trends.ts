import type { PositionFinancialStatementRow } from "./contracts.ts";

export type FinancialDelta = {
  absolute: number;
  percent: number | null;
  direction: "up" | "down" | "flat";
};

export function numericFinancialValue(row: PositionFinancialStatementRow | undefined): number | null {
  if (!row || row.valueId == null || row.valueNumber == null) return null;
  const value = Number(row.valueNumber);
  return Number.isFinite(value) ? value : null;
}

export function financialDelta(
  current: PositionFinancialStatementRow | undefined,
  previous: PositionFinancialStatementRow | undefined,
): FinancialDelta | null {
  const currentValue = numericFinancialValue(current);
  const previousValue = numericFinancialValue(previous);
  if (currentValue == null || previousValue == null) return null;

  const absolute = currentValue - previousValue;
  const percent = previousValue === 0 ? null : (absolute / Math.abs(previousValue)) * 100;
  return {
    absolute,
    percent,
    direction: absolute > 0 ? "up" : absolute < 0 ? "down" : "flat",
  };
}

export function financialTrustLabel(row: PositionFinancialStatementRow | undefined): string | null {
  if (!row || row.valueId == null) return null;
  if (row.preliminary) return "Preliminary";
  if (row.isRestatement) return "Restated";
  if (row.isDerived) return "Derived";
  const status = row.sourceVersionStatus?.trim();
  if (status) return status[0].toUpperCase() + status.slice(1).toLowerCase();
  return "Final";
}

export function financialAsOf(row: PositionFinancialStatementRow | undefined): string | null {
  if (!row || row.valueId == null) return null;
  return row.asOfDate ?? row.periodEnd ?? row.sourceDocumentPeriodEnd ?? row.reportPeriod ?? null;
}
