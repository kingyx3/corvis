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
  const className = `metric-card${tone === "warning" ? " warning" : ""}${onClick ? " metric-card-actionable" : ""}`;
  const style: CSSProperties | undefined = order == null ? undefined : { order };
  const body = <>
    <div className="metric-head"><span>{label}</span>{icon != null && <span className="metric-icon">{icon}</span>}</div>
    <strong>{value}</strong>
    {detail != null && <p>{detail}</p>}
  </>;
  // The trend indicator (Sparkline) contains its own interactive <details>/<summary>
  // disclosure, so it must never end up nested inside the card's own <button> —
  // that's both invalid HTML and an accessibility-tree violation. When the card is
  // actionable, only the label/value/detail sit inside the button; trend renders
  // as a sibling.
  return onClick
    ? <div className={className} style={style}>
        <button type="button" className="metric-card-hit-area" onClick={onClick} aria-controls={ariaControls} aria-label={ariaLabel}>{body}</button>
        {trend != null && <div className="metric-card-trend">{trend}</div>}
      </div>
    : <div className={className} style={style} aria-label={ariaLabel}>{body}{trend != null && <div className="metric-card-trend">{trend}</div>}</div>;
}
