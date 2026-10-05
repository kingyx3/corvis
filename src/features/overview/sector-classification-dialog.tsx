"use client";

import { useEffect, useState } from "react";
import { SECTORS, type CompanySectorRecord } from "@/core/sector-taxonomy";
import { Modal } from "@/components/ui/modal";
import { workspacePort } from "@/runtime/workspace-services";

const REASONS = [
  { value: "company_business_description", label: "Company's primary business activity" },
  { value: "gp_reported_sector", label: "Sector as reported by the GP" },
  { value: "reviewer_correction", label: "Correcting an earlier classification" },
] as const;

/**
 * Review Analyst workflow for the governed company → sector classification
 * behind the Overview's exposure-by-sector breakdown. Each save is one
 * versioned, audited assignment; a stale version (someone else classified
 * the company meanwhile) reloads the list instead of overwriting.
 */
export function SectorClassificationDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [companies, setCompanies] = useState<CompanySectorRecord[] | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [reason, setReason] = useState<string>(REASONS[0].value);
  const [saving, setSaving] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => workspacePort.listCompanySectors().then((rows) => { setCompanies(rows); setError(null); }, (reason: unknown) => setError(reason instanceof Error ? reason.message : "Company sectors are unavailable"));
  useEffect(() => { void load(); }, []);

  const save = async (company: CompanySectorRecord) => {
    const sectorCode = draft[company.companyId];
    if (!sectorCode || sectorCode === company.sectorCode) return;
    setSaving(company.companyId);
    setMessage(null);
    try {
      await workspacePort.assignCompanySector({ companyId: company.companyId, sectorCode, expectedVersion: company.version, reason });
      setDraft((current) => { const next = { ...current }; delete next[company.companyId]; return next; });
      setMessage({ tone: "success", text: `${company.company} classified as ${SECTORS.find((sector) => sector.code === sectorCode)?.name ?? sectorCode}.` });
      await load();
      onChanged();
    } catch (failure) {
      const text = failure instanceof Error ? failure.message : "Classification failed";
      setMessage({ tone: "danger", text: /version_conflict/.test(text) ? `${company.company} was classified by someone else meanwhile; the list has been refreshed.` : text });
      await load();
    } finally {
      setSaving(null);
    }
  };

  const unclassified = companies?.filter((company) => !company.sectorCode).length ?? 0;

  return <Modal label="Classify portfolio companies by sector" onClose={onClose} width="min(760px, 100%)">
    <div className="dialog-body sector-dialog">
      <h2>Classify portfolio companies by sector</h2>
      <p>Assign each company to one sector of the Corvis sector taxonomy. Each change is recorded as a new, attributable version and flows into the exposure-by-sector breakdown.{companies ? ` ${unclassified} of ${companies.length} ${companies.length === 1 ? "company is" : "companies are"} unclassified.` : ""}</p>
      <label className="form-field">Reason recorded with each change<select value={reason} onChange={(event) => setReason(event.target.value)}>{REASONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      {message && <p role="status" className={`sector-dialog-message tone-${message.tone}`}>{message.text}</p>}
      {error && <p role="alert" className="sector-dialog-message tone-danger">{error}</p>}
      {!companies && !error && <p aria-busy="true">Loading portfolio companies…</p>}
      {companies && companies.length === 0 && <p>No entitled portfolio companies yet.</p>}
      {companies && companies.length > 0 && <table className="chart-data-table sector-table">
        <caption className="visually-hidden">Portfolio company sector classifications</caption>
        <thead><tr><th scope="col">Company</th><th scope="col">Current sector</th><th scope="col">Assign sector</th><th scope="col"><span className="visually-hidden">Save</span></th></tr></thead>
        <tbody>{companies.map((company) => {
          const selected = draft[company.companyId] ?? company.sectorCode ?? "";
          const changed = Boolean(draft[company.companyId]) && draft[company.companyId] !== company.sectorCode;
          return <tr key={company.companyId}>
            <th scope="row">{company.company}<small>{company.fundIds.length} {company.fundIds.length === 1 ? "fund" : "funds"}</small></th>
            <td>{company.sectorName ?? <span className="status-pill status-review"><span className="status-dot" />Unclassified</span>}</td>
            <td><select className="select-control" aria-label={`Sector for ${company.company}`} value={selected} onChange={(event) => setDraft((current) => ({ ...current, [company.companyId]: event.target.value }))}>
              {!company.sectorCode && <option value="" disabled>Choose a sector</option>}
              {SECTORS.map((sector) => <option key={sector.code} value={sector.code}>{sector.name}</option>)}
            </select></td>
            <td><button type="button" className="secondary-button" disabled={!changed || saving !== null} onClick={() => void save(company)} aria-label={`Save sector for ${company.company}`}>{saving === company.companyId ? "Saving…" : "Save"}</button></td>
          </tr>;
        })}</tbody>
      </table>}
      <div className="dialog-actions"><button type="button" className="primary-button" onClick={onClose}>Done</button></div>
    </div>
  </Modal>;
}
