"use client";

import { useEffect, useRef, useState } from "react";
import {
  EXPORT_SCHEDULE_FAILURE_REASON_LABEL,
  EXPORT_SCHEDULE_FORMAT_LABEL,
  EXPORT_SCHEDULE_STATUS_LABEL,
  EXPORT_SCHEDULE_TRIGGER_LABEL,
  describeTriggerKey,
  scheduleSummary,
  type ExportSchedule,
  type ExportScheduleRun,
} from "@/modules/delivery/domain/export-schedule";
import { Icon } from "@/shared/ui/icon";
import { StatusPill } from "@/shared/ui/status-pill";
import {
  deleteExportSchedule,
  exportScheduleErrorMessage,
  listExportScheduleRuns,
  listExportSchedules,
  setExportScheduleNotification,
  setExportScheduleStatus,
  type ScheduleScopeChoice,
} from "@/modules/delivery/ui/export-schedules/api";
import { displayDate } from "@/shared/lib/display-format";

type LoadState = { kind: "loading" } | { kind: "error" } | { kind: "ready"; schedules: ExportSchedule[]; runs: ExportScheduleRun[] };

function stateLabel(state: string): string { return state.replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase()); }

function runResult(run: ExportScheduleRun): { pill: string; detail: string } {
  if (run.outcome === "failed") return { pill: "Failed", detail: run.failureReason ? EXPORT_SCHEDULE_FAILURE_REASON_LABEL[run.failureReason] : "Nothing was exported." };
  return { pill: run.exportState ? stateLabel(run.exportState) : "Requested", detail: "Export requested through the governed pipeline. Download it from Recent exports once complete." };
}

/**
 * Scheduled exports (F4) inside Data delivery: the person's schedules with pause, resume and delete, and the history of
 * every run (including runs that were refused and exported nothing). Organization Admins can switch to every schedule
 * in the organization, read-only: only an owner changes a schedule.
 */
export function ExportSchedulesPanel({ canViewAll, refreshKey = 0 }: { canViewAll: boolean; refreshKey?: number }) {
  const [scope, setScope] = useState<ScheduleScopeChoice>("mine");
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const requestId = useRef(0);
  const effectiveScope: ScheduleScopeChoice = canViewAll ? scope : "mine";

  useEffect(() => {
    const controller = new AbortController();
    const current = ++requestId.current;
    void Promise.all([listExportSchedules(effectiveScope, controller.signal), listExportScheduleRuns(effectiveScope, controller.signal)])
      .then(([schedules, runs]) => { if (current === requestId.current) setState({ kind: "ready", schedules, runs }); })
      .catch(() => { if (current === requestId.current && !controller.signal.aborted) setState({ kind: "error" }); });
    return () => controller.abort();
  }, [effectiveScope, reloadKey, refreshKey]);

  const reload = () => setReloadKey((key) => key + 1);
  const change = async (item: ExportSchedule, action: "pause" | "resume") => {
    setBusy(item.scheduleId);
    setMessage(null);
    try {
      await setExportScheduleStatus(item.scheduleId, action);
      setMessage({ tone: "success", text: action === "pause" ? `Paused “${item.label}”. Nothing runs until you resume it.` : `Resumed “${item.label}”.` });
      reload();
    } catch (reason) {
      setMessage({ tone: "error", text: exportScheduleErrorMessage(reason, "The schedule could not be changed. Try again.") });
    } finally { setBusy(null); }
  };
  const toggleNotification = async (item: ExportSchedule) => {
    setBusy(item.scheduleId);
    setMessage(null);
    try {
      await setExportScheduleNotification(item.scheduleId, !item.notifyOnCompletion);
      setMessage({ tone: "success", text: item.notifyOnCompletion ? `Emails about “${item.label}” are off.` : `Emails about “${item.label}” are on.` });
      reload();
    } catch (reason) {
      setMessage({ tone: "error", text: exportScheduleErrorMessage(reason, "The notification setting could not be changed. Try again.") });
    } finally { setBusy(null); }
  };
  const remove = async (item: ExportSchedule) => {
    setBusy(item.scheduleId);
    setMessage(null);
    try {
      await deleteExportSchedule(item.scheduleId);
      setConfirmDelete(null);
      setMessage({ tone: "success", text: `Deleted “${item.label}”. Its past runs stay in history.` });
      reload();
    } catch (reason) {
      setMessage({ tone: "error", text: exportScheduleErrorMessage(reason, "The schedule could not be deleted. Try again.") });
    } finally { setBusy(null); }
  };

  const schedules = state.kind === "ready" ? state.schedules : [];
  const runs = state.kind === "ready" ? state.runs : [];
  return <section className="panel export-schedules" aria-labelledby="export-schedules-heading">
    <div className="panel-heading"><div><p className="eyebrow">Scheduled exports</p><h2 id="export-schedules-heading">Export schedules</h2></div>
      {canViewAll && <fieldset className="position-financials-segmented"><legend>Whose schedules</legend>
        {(["mine", "all"] as const).map((value) => <button type="button" key={value} aria-pressed={scope === value} className={scope === value ? "active" : ""} onClick={() => { setScope(value); setState({ kind: "loading" }); }}>{value === "mine" ? "My schedules" : "Everyone in my organization"}</button>)}
      </fieldset>}
    </div>
    <p className="field-hint">A schedule requests a governed export of a saved view when a matching snapshot is published, or on the 1st of every month or quarter (UTC). Each run is made as the schedule&apos;s owner, with their access and your organization&apos;s data rights checked again every time. Create one with “Schedule export” beside Export this view in Portfolio analytics (Position financials or the Performance scorecard) or Data review.</p>
    <div className="data-issues-status" role="status" aria-live="polite">{message?.tone === "success" ? message.text : ""}</div>
    {message?.tone === "error" && <div className="lineage-note tone-danger" role="alert"><Icon name="alert"/><div><strong>Something went wrong</strong><span>{message.text}</span></div></div>}
    {state.kind === "loading" && <div className="table-card" role="status" aria-label="Loading schedules"><div className="empty-cell">Loading scheduled exports…</div></div>}
    {state.kind === "error" && <div className="table-card" role="alert"><div className="empty-cell"><strong>Scheduled exports are unavailable.</strong> Nothing was changed. <button type="button" className="text-button" onClick={reload}>Try again</button></div></div>}
    {state.kind === "ready" && schedules.length === 0 && <div className="table-card"><div className="empty-cell">{effectiveScope === "all" ? "Nobody in your organization has scheduled an export yet." : "No schedules yet. Use “Schedule export” beside Export this view to create one."}</div></div>}
    {schedules.length > 0 && <ul className="export-schedule-list" aria-label="Export schedules">
      {schedules.map((item) => {
        const headingId = `export-schedule-${item.scheduleId}`;
        return <li className="export-schedule-card" key={item.scheduleId} data-status={item.status} aria-labelledby={headingId}>
          <div className="export-schedule-head">
            <div><h3 id={headingId}>{item.label}</h3><span className="table-secondary">{item.scopeLabel} · {EXPORT_SCHEDULE_FORMAT_LABEL[item.format]}{item.ownedByMe ? "" : ` · owned by ${item.owner}`}</span></div>
            <StatusPill status={EXPORT_SCHEDULE_STATUS_LABEL[item.status]}/>
          </div>
          <p className="data-issue-summary">{EXPORT_SCHEDULE_TRIGGER_LABEL[item.trigger]}. {scheduleSummary(item)}</p>
          <p className="data-issue-summary">{item.nextRunAt ? <>Next run: <time dateTime={item.nextRunAt}>{displayDate(item.nextRunAt, { dateStyle: "medium" })}</time> (UTC). </> : null}{item.lastRun ? `Last run ${displayDate(item.lastRun.createdAt, { timeStyle: "short" })}: ${runResult(item.lastRun).pill}${item.lastRun.failureReason ? ` — ${EXPORT_SCHEDULE_FAILURE_REASON_LABEL[item.lastRun.failureReason]}` : ""}.` : "It has not run yet."}</p>
          <p className="data-issue-summary">{item.notifyOnCompletion ? "The owner is emailed when a run is ready, and when a run is refused or fails." : "Emails about this schedule are off. Runs still appear below."}</p>
          {item.ownedByMe && <div className="data-issue-actions">
            <button type="button" className="secondary-button" disabled={busy === item.scheduleId} aria-pressed={item.notifyOnCompletion} aria-label={`Email me about ${item.label}`} onClick={() => void toggleNotification(item)}>{item.notifyOnCompletion ? "Emails on" : "Emails off"}</button>
            {item.status === "active" && <button type="button" className="secondary-button" disabled={busy === item.scheduleId} aria-label={`Pause ${item.label}`} onClick={() => void change(item, "pause")}>Pause</button>}
            {item.status === "paused" && <button type="button" className="secondary-button" disabled={busy === item.scheduleId} aria-label={`Resume ${item.label}`} onClick={() => void change(item, "resume")}>Resume</button>}
            {confirmDelete === item.scheduleId
              ? <>
                <button type="button" className="danger-button" disabled={busy === item.scheduleId} aria-label={`Confirm delete ${item.label}`} onClick={() => void remove(item)}>Delete schedule</button>
                <button type="button" className="secondary-button" disabled={busy === item.scheduleId} onClick={() => setConfirmDelete(null)}>Keep it</button>
              </>
              : <button type="button" className="secondary-button" disabled={busy === item.scheduleId} aria-label={`Delete ${item.label}`} onClick={() => setConfirmDelete(item.scheduleId)}>Delete</button>}
          </div>}
        </li>;
      })}
    </ul>}

    {state.kind === "ready" && <>
      <h3 className="export-schedule-runs-heading" id="export-schedule-runs-heading">Scheduled runs</h3>
      <div className="table-card" tabIndex={0} role="region" aria-labelledby="export-schedule-runs-heading"><table className="data-table history-table"><thead><tr><th>Run</th><th>Schedule</th><th>Scope</th><th>Format</th><th>Trigger</th><th>Result</th></tr></thead><tbody>
        {runs.length === 0 && <tr><td colSpan={6} className="empty-cell">No scheduled runs yet.</td></tr>}
        {runs.map((run) => {
          const result = runResult(run);
          return <tr key={run.runId}><td><strong className="nowrap">{displayDate(run.createdAt, { timeStyle: "short" })}</strong></td><td>{run.scheduleLabel}</td><td>{run.scopeLabel}</td><td>{EXPORT_SCHEDULE_FORMAT_LABEL[run.format]}</td><td>{describeTriggerKey(run.triggerKey)}</td><td><StatusPill status={result.pill}/><span className="table-secondary">{result.detail}</span></td></tr>;
        })}
      </tbody></table></div>
    </>}
  </section>;
}
