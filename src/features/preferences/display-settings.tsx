"use client";
import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { DEFAULT_DISPLAY, formatDisplayDate, formatDisplayNumber } from "@/core/display-preferences";
import { usePreferences } from "./preference-provider";
export function DisplaySettings({ onClose }: { onClose: () => void }) {
  const preferences = usePreferences(); const [value, setValue] = useState(preferences.display ?? DEFAULT_DISPLAY); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const zones = [...new Set([value.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone, "UTC", ...Intl.supportedValuesOf("timeZone")])];
  return <Modal label="Display preferences" onClose={onClose}><form className="dialog-body" onSubmit={(event) => { event.preventDefault(); setBusy(true); void preferences.saveDisplay(value).then(onClose).catch((e) => setError(e instanceof Error ? e.message : "Could not save preferences")).finally(() => setBusy(false)); }}><h2>Display preferences</h2><p>Choose how dates and numbers appear. Source values and machine-readable exports stay unchanged. Period-end and as-of dates keep their calendar day.</p>
    <label className="form-field">Time zone<select aria-label="Time zone" autoFocus value={value.timeZone} onChange={(e) => setValue({ ...value, timeZone: e.target.value })}>{zones.map((zone) => <option key={zone}>{zone}</option>)}</select></label>
    <label className="form-field">Date format<select aria-label="Date format" value={value.dateFormat} onChange={(e) => setValue({ ...value, dateFormat: e.target.value as typeof value.dateFormat })}><option value="day-first">30 Sep 2026</option><option value="month-first">Sep 30, 2026</option><option value="iso">2026-09-30</option></select></label>
    <label className="form-field">Number format<select aria-label="Number format" value={value.numberFormat} onChange={(e) => setValue({ ...value, numberFormat: e.target.value as typeof value.numberFormat })}><option value="en-US">1,234.5</option><option value="de-DE">1.234,5</option><option value="fr-FR">1 234,5</option></select></label>
    <p role="status">Preview: {formatDisplayDate("2026-09-30", value)} · {formatDisplayNumber(1234.5, value)} · {value.timeZone}</p>{(error || preferences.error) && <p role="alert">{error || preferences.error}</p>}<div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || !preferences.ready || !!preferences.error}>{busy ? "Saving…" : "Save preferences"}</button></div></form></Modal>;
}
