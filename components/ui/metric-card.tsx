import type { CSSProperties, ReactNode } from "react";

export type MetricCardTone = "default" | "warning";

export type MetricCardProps = {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  icon?: ReactNode;
  trend?: ReactNode;
  tone?: MetricCardTone;
  order?: number;
  onClick?: () => void;
  ariaControls?: string;
  ariaLabel?: string;
};

/** Metric summary that renders as a native button only when it is actionable. */
export function MetricCard({ label, value, detail, icon, trend, tone = "default", order, onClick, ariaControls, ariaLabel }: MetricCardProps) {
  const className = `metric-card${tone === "warning" ? " warning" : ""}`;
  const style: CSSProperties | undefined = order == null ? undefined : { order };
  const body = <>
    <div className="metric-head"><span>{label}</span>{icon != null && <span className="metric-icon">{icon}</span>}</div>
    <strong>{value}</strong>
    {detail != null && <p>{detail}</p>}
    {trend != null && <div className="metric-card-trend">{trend}</div>}
  </>;
  return onClick
    ? <button type="button" className={className} style={style} onClick={onClick} aria-controls={ariaControls} aria-label={ariaLabel}>{body}</button>
    : <div className={className} style={style} aria-label={ariaLabel}>{body}</div>;
}
