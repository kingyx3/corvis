"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import type { ExportFormat } from "@/core/delivery";
import type { ScheduledExportScope } from "@/core/export-schedule";
import {
  EXPORT_SCHEDULE_FORMATS,
  EXPORT_SCHEDULE_FORMAT_LABEL,
  EXPORT_SCHEDULE_TRIGGERS,
  EXPORT_SCHEDULE_TRIGGER_LABEL,
  MAX_SCHEDULE_LABEL_LENGTH,
  defaultScheduleLabel,
  exportScopeSummary,
  type ExportScheduleTrigger,
} from "@/core/export-schedule";
import { Icon } from "@/components/ui/icon";
import { Modal } from "@/components/ui/modal";
import { createExportSchedule, exportScheduleErrorMessage } from "@/features/export-schedules/api";

/**
 * What an on-publish trigger means for this scope, in words: a snapshot scope follows that snapshot, a position scope (or a
 * scorecard of one fund) follows its fund, and an unfiltered scorecard follows every fund the owner is entitled to when it runs.
 */
function publishTriggerLabel(scope: ScheduledExportScope): string {
  if ("snapshotId" in scope) return "When a new version of this snapshot is published";
  if ("performanceScorecard" in scope && scope.fundId === undefined) return "When a snapshot of any fund you are entitled to is published";
  return "When a snapshot of this fund is published";
}

/**
 * "Schedule this export" (F4): saves the scope of an "Export this view" request with a trigger and a format. Nothing is
 * exported now. Each later run is made as the person who saved it, with their access and their organization's data
 * rights checked again at that moment; a run that cannot be authorized exports nothing and is recorded as failed. The
 * idempotency key is made once per opened dialog, so a retry after a network failure can never save two schedules.
 */
export function ScheduleExportDialog({ scope, onClose }: { scope: ScheduledExportScope; onClose: () => void }) {
  const [trigger, setTrigger] = useState<ExportScheduleTrigger>("monthly");
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [label, setLabel] = useState<string | null>(null);
  const [notifyOnCompletion, setNotifyOnCompletion] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ label: string; nextRunAt: string | null } | null>(null);
  const idempotencyKey = useRef<string>(crypto.randomUUID());
  const nameId = useId();
  const hintId = useId();
  const notifyId = useId();
  const notifyHintId = useId();
  // Until the person types their own name, it follows the cadence they pick.
  const effectiveLabel = label ?? defaultScheduleLabel(scope, trigger);
  const trimmed = effectiveLabel.trim();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { item } = await createExportSchedule({ idempotencyKey: idempotencyKey.current, label: trimmed, scope, format, trigger, notifyOnCompletion });
      setSaved({ label: item.label, nextRunAt: item.nextRunAt });
    } catch (reason) {
      setError(exportScheduleErrorMessage(reason, "The schedule could not be saved. Nothing was exported; try again."));
      setBusy(false);
    }
  };

  if (saved) {
    return <Modal label="Schedule saved" onClose={onClose} width="min(520px, 100%)">
      <div className="dialog-body">
        <h2>Schedule saved</h2>
        <div className="lineage-note tone-success" role="status"><Icon name="check"/><div><strong>{saved.label}</strong><span>{saved.nextRunAt ? `The first run is on ${new Date(saved.nextRunAt).toLocaleDateString(undefined, { dateStyle: "long", timeZone: "UTC" })} (UTC).` : "It runs the next time a matching snapshot is published."} Nothing was exported now.</span></div></div>
        <p className="field-hint">Pause, resume or delete it under Data delivery. Every run appears in Data delivery with this name.</p>
      </div>
      <div className="dialog-actions"><button type="button" className="primary-button" data-autofocus onClick={onClose}>Close</button></div>
    </Modal>;
  }

  return <Modal label="Schedule this export" onClose={() => { if (!busy) onClose(); }} width="min(560px, 100%)">
    <form className="dialog-body schedule-form" onSubmit={(event) => void submit(event)}>
      <h2>Schedule this export</h2>
      <p>Request a governed export of exactly this view again and again, without exporting it by hand.</p>
      <dl className="preview-dl schedule-scope" aria-label="What will be exported">
        <div className="form-field"><dt>Scope</dt><dd>{exportScopeSummary(scope)}</dd></div>
      </dl>
      {"performanceScorecard" in scope && scope.fundId === undefined && <p className="field-hint">This scorecard covers every fund you are entitled to when each run is made, so funds added to or removed from your access later are included or left out of later runs.</p>}
      <label className="form-field">
        <span>Run</span>
        <select className="filter-button" value={trigger} disabled={busy} onChange={(event) => setTrigger(EXPORT_SCHEDULE_TRIGGERS.find((value) => value === event.target.value) ?? "monthly")}>
          {EXPORT_SCHEDULE_TRIGGERS.map((value) => <option key={value} value={value}>{value === "on_publish" ? publishTriggerLabel(scope) : EXPORT_SCHEDULE_TRIGGER_LABEL[value]}</option>)}
        </select>
      </label>
      <label className="form-field">
        <span>Format</span>
        <select className="filter-button" value={format} disabled={busy} onChange={(event) => setFormat(EXPORT_SCHEDULE_FORMATS.find((value) => value === event.target.value) ?? "csv")}>
          {EXPORT_SCHEDULE_FORMATS.map((value) => <option key={value} value={value}>{EXPORT_SCHEDULE_FORMAT_LABEL[value]}</option>)}
        </select>
      </label>
      <label className="form-field" htmlFor={nameId}>
        <span>Name</span>
        <input id={nameId} className="input-control" required maxLength={MAX_SCHEDULE_LABEL_LENGTH} value={effectiveLabel} disabled={busy} aria-describedby={hintId} onChange={(event) => setLabel(event.target.value)}/>
        <small id={hintId} className="field-hint">Shown with every run in Data delivery. Parquet is offered only where your organization has it enabled.</small>
      </label>
      <p className="field-hint">Each run is made as you: your access and your organization&apos;s data rights are checked again every time. A run that cannot be authorized exports nothing and is shown as failed.</p>
      <label className="check-field" htmlFor={notifyId}><input id={notifyId} type="checkbox" checked={notifyOnCompletion} disabled={busy} aria-describedby={notifyHintId} onChange={(event) => setNotifyOnCompletion(event.target.checked)}/><span>Email me about this schedule</span></label>
      <small id={notifyHintId} className="field-hint">When a run&apos;s export is ready, and when a run is refused or fails. The emails never contain data, and follow your &ldquo;Export ready&rdquo; and &ldquo;Scheduled export did not run&rdquo; notification settings. You can change this later under Data delivery.</small>
      {error && <div className="lineage-note tone-danger" role="alert"><Icon name="alert"/><div><strong>Schedule not saved</strong><span>{error}</span></div></div>}
      <div className="dialog-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy || !trimmed}>{busy ? "Saving…" : "Save schedule"}</button>
      </div>
    </form>
  </Modal>;
}

/** The entry point placed beside an "Export this view" button. Nothing renders when there is no scope to schedule. */
export function ScheduleExportButton({ scope, label = "Schedule export", className = "secondary-button" }: { scope: ScheduledExportScope | null; label?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  if (!scope) return null;
  return <>
    <button type="button" className={className} aria-haspopup="dialog" onClick={() => setOpen(true)}><Icon name="clock" size={16}/>{label}</button>
    {open && <ScheduleExportDialog scope={scope} onClose={() => setOpen(false)}/>}
  </>;
}
