"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import {
  DATA_ISSUE_FIGURE_LABEL,
  MAX_COMMENT_LENGTH,
  dataIssueScopeSummary,
  type DataIssueFigure,
  type DataIssueScope,
} from "@/modules/governance/domain/data-issue";
import { Icon } from "@/shared/ui/icon";
import { Modal } from "@/shared/ui/modal";
import { dataIssueErrorMessage, reportDataIssue } from "@/modules/governance/ui/data-issues/api";
import { viewHash } from "@/shared/lib/view-hash";

/** One thing the person picks inside the dialog to pin down the figure (a fund period, a line item, a reporting period). */
export type ReportIssueChoiceGroup = {
  id: string;
  label: string;
  options: Array<{ value: string; label: string; scope: Partial<DataIssueScope> }>;
  /** Offer a "whole figure" option that adds nothing to the scope. */
  optionalLabel?: string;
  defaultValue?: string;
};

export type ReportIssueContext = {
  figure: DataIssueFigure;
  /** The scope already known where the button sits (fund, company, snapshot...). */
  base: Partial<DataIssueScope>;
  groups?: ReportIssueChoiceGroup[];
};

const NONE = "";

/** The scope the current selections add up to, or null while a required piece (fund, period) is still missing. */
function resolveScope(context: ReportIssueContext, selections: Record<string, string>): DataIssueScope | null {
  const merged: Partial<DataIssueScope> = { ...context.base };
  for (const group of context.groups ?? []) {
    const chosen = group.options.find((option) => option.value === selections[group.id]);
    if (chosen) Object.assign(merged, chosen.scope);
  }
  return merged.fundId && merged.reportPeriod ? merged as DataIssueScope : null;
}

function initialSelections(context: ReportIssueContext): Record<string, string> {
  return Object.fromEntries((context.groups ?? []).map((group) => [group.id, group.defaultValue ?? (group.optionalLabel ? NONE : group.options[0]?.value ?? NONE)]));
}

/**
 * "Report an issue" on a published figure (F5). The person confirms which figure and scope they mean, says what looks
 * wrong, and sends it to Data Operations. The dialog says plainly that reporting changes nothing: only the governed
 * correction flow can change data or publication. The idempotency key is made once per opened dialog, so a retry after
 * a network failure can never file the report twice.
 */
export function ReportIssueDialog({ context, onClose }: { context: ReportIssueContext; onClose: () => void }) {
  const [selections, setSelections] = useState(() => initialSelections(context));
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ summary: string } | null>(null);
  const idempotencyKey = useRef<string>(crypto.randomUUID());
  const commentId = useId();
  const hintId = useId();
  const scope = resolveScope(context, selections);
  const trimmed = comment.trim();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!scope || !trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { item } = await reportDataIssue({ idempotencyKey: idempotencyKey.current, figure: context.figure, scope, comment: trimmed });
      setSent({ summary: dataIssueScopeSummary(item.scope) });
    } catch (reason) {
      setError(dataIssueErrorMessage(reason, "The report could not be sent. Nothing was changed; try again."));
      setBusy(false);
    }
  };

  if (sent) {
    return <Modal label="Report received" onClose={onClose} width="min(520px, 100%)">
      <div className="dialog-body">
        <h2>Report received</h2>
        <div className="lineage-note tone-success" role="status"><Icon name="check"/><div><strong>Data Operations has your report</strong><span>{sent.summary}. You will see its status under Data issues, and get an email when it changes if you have email notifications on.</span></div></div>
        <p className="field-hint">Reporting does not change any data or publication. If a correction is needed it goes through the governed correction flow and the figure is replaced by a new publication.</p>
      </div>
      <div className="dialog-actions">
        <button type="button" className="secondary-button" data-autofocus onClick={onClose}>Close</button>
        <button type="button" className="primary-button" onClick={() => { onClose(); window.location.hash = viewHash("issues"); }}>View my reports</button>
      </div>
    </Modal>;
  }

  return <Modal label="Report an issue" onClose={() => { if (!busy) onClose(); }} width="min(560px, 100%)">
    <form className="dialog-body data-issue-form" onSubmit={(event) => void submit(event)}>
      <h2>Report an issue</h2>
      <p>Tell Data Operations what looks wrong with this published {DATA_ISSUE_FIGURE_LABEL[context.figure].toLowerCase()} figure.</p>
      {(context.groups ?? []).map((group) => <label className="form-field" key={group.id}>
        <span>{group.label}</span>
        <select className="filter-button" value={selections[group.id] ?? NONE} disabled={busy} onChange={(event) => setSelections((current) => ({ ...current, [group.id]: event.target.value }))}>
          {group.optionalLabel && <option value={NONE}>{group.optionalLabel}</option>}
          {group.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>)}
      <dl className="preview-dl data-issue-scope" aria-label="What you are reporting">
        <div className="form-field"><dt>Figure</dt><dd>{DATA_ISSUE_FIGURE_LABEL[context.figure]}</dd></div>
        <div className="form-field"><dt>Scope</dt><dd>{scope ? dataIssueScopeSummary(scope) : "Choose a fund period to report on."}</dd></div>
      </dl>
      <label className="form-field" htmlFor={commentId}>
        <span>What looks wrong?</span>
        <textarea id={commentId} className="input-control" rows={5} required maxLength={MAX_COMMENT_LENGTH} value={comment} disabled={busy} aria-describedby={hintId}
          placeholder="For example: revenue is about 10% higher than in the company's own report." onChange={(event) => setComment(event.target.value)}/>
        <small id={hintId} className="field-hint">{trimmed.length.toLocaleString()} / {MAX_COMMENT_LENGTH.toLocaleString()}. Reporting does not change any data or publication; Data Operations investigates and you can follow the status under Data issues.</small>
      </label>
      {error && <div className="lineage-note tone-danger" role="alert"><Icon name="alert"/><div><strong>Report not sent</strong><span>{error}</span></div></div>}
      <div className="dialog-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy || !scope || !trimmed}>{busy ? "Sending…" : "Send report"}</button>
      </div>
    </form>
  </Modal>;
}

/** The entry point placed beside a published figure. Nothing renders when there is nothing to report on. */
export function ReportIssueButton({ context, label = "Report an issue", className = "secondary-button" }: {
  context: ReportIssueContext | null;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!context) return null;
  return <>
    <button type="button" className={className} aria-haspopup="dialog" onClick={() => setOpen(true)}><Icon name="alert" size={16}/>{label}</button>
    {open && <ReportIssueDialog context={context} onClose={() => setOpen(false)}/>}
  </>;
}
