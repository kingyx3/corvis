"use client";

import { Icon } from "@/components/ui/icon";

export type FundPeriodStatus = {
  fund: string;
  period: string;
  blockingExceptions: number;
  needsReview: number;
};

/**
 * Persistent cross-view chip (#182 D14): the active fund-period's blocking
 * review/exception count, visible from every view so a user never has to
 * navigate to Data review just to find out whether anything is blocking.
 */
export function FundPeriodStatusChip({ status, onOpen }: { status: FundPeriodStatus | null; onOpen: () => void }) {
  if (!status) return null;
  const total = status.blockingExceptions + status.needsReview;
  const tone = status.blockingExceptions > 0 ? "danger" : status.needsReview > 0 ? "warning" : "clear";
  const detail = total === 0
    ? "All clear"
    : [
      status.blockingExceptions > 0 ? `${status.blockingExceptions} blocking ${status.blockingExceptions === 1 ? "exception" : "exceptions"}` : null,
      status.needsReview > 0 ? `${status.needsReview} need${status.needsReview === 1 ? "s" : ""} review` : null,
    ].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      className={`fund-period-status-chip tone-${tone}`}
      onClick={onOpen}
      aria-label={`${status.fund} · ${status.period}: ${detail}. Open Data review.`}
    >
      {tone !== "clear" ? <Icon name="alert" size={14}/> : <Icon name="check" size={14}/>}
      <span className="fund-period-status-text"><strong>{status.fund}</strong><span className="fund-period-status-period">{status.period}</span></span>
      <span className="fund-period-status-count">{detail}</span>
    </button>
  );
}
