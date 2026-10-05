"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { StatusPill } from "@/shared/ui/status-pill";
import { displayDate } from "@/shared/lib/display-format";
import { workspaceContextHeaders } from "@/shared/lib/workspace-context";

/**
 * Corvis operations (F10f, #326): full tenant data exports whose build failed or is being retried, across tenants. The
 * customer only ever sees "could not be built"; this page shows the stored cause so operations can tell a row-cap failure
 * (retrying cannot help) from a storage fault or an abandoned build. It shows no requester, reason, approver or data.
 */

type Issue = {
  tenantId: string;
  tenantName: string;
  requestId: string;
  status: "failed" | "retrying";
  attempts: number;
  lastError: string | null;
  requestedAt: string;
  changedAt: string;
  nextAttemptAt: string | null;
};
type Filter = "all" | "failed" | "retrying";

const PAGE_SIZE = 25;
const FILTERS: Array<[Filter, string]> = [["all", "All"], ["failed", "Failed"], ["retrying", "Retrying"]];

function time(value: string): string { return displayDate(value, { timeStyle: "short" }); }

async function load(filter: Filter, cursor: string | null, signal?: AbortSignal): Promise<{ items: Issue[]; nextCursor: string | null }> {
  const base = process.env.NEXT_PUBLIC_CORVIS_API_BASE?.replace(/\/$/, "") ?? "";
  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (filter !== "all") query.set("status", filter);
  if (cursor) query.set("cursor", cursor);
  const response = await fetch(`${base}/api/v1/admin/tenant-export-builds?${query}`, { credentials: "include", cache: "no-store", headers: workspaceContextHeaders(), signal });
  const body = await response.json().catch(() => ({})) as { data?: Issue[]; nextCursor?: string | null; error?: string };
  if (!response.ok) throw new Error(body.error === "operations_admin_required" ? "Only Corvis operations can view export builds." : "Export builds are unavailable.");
  return { items: body.data ?? [], nextCursor: body.nextCursor ?? null };
}

export default function TenantExportBuildsPage() {
  const [filter, setFilter] = useState<Filter>("all");
  const [items, setItems] = useState<Issue[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const latest = useRef(0);
  const filterLabelId = useId();

  useEffect(() => {
    const controller = new AbortController();
    const current = ++latest.current;
    void load(filter, null, controller.signal)
      .then((page) => { if (current === latest.current) { setItems(page.items); setNextCursor(page.nextCursor); setError(""); } })
      .catch((caught: unknown) => { if (current === latest.current && !controller.signal.aborted) { setItems([]); setNextCursor(null); setError(caught instanceof Error ? caught.message : "Export builds are unavailable."); } })
      .finally(() => { if (current === latest.current) setLoading(false); });
    return () => controller.abort();
  }, [filter, reloadKey]);

  const more = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await load(filter, nextCursor);
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Export builds are unavailable.");
    } finally { setLoadingMore(false); }
  }, [filter, nextCursor]);

  return <main id="main-content"><div className="admin-shell">
    <section className="page-heading"><div><p className="eyebrow">Corvis operations</p><h1>Tenant export builds</h1><p className="lede">Full data exports whose build failed or is being retried, across tenants. A failed build delivered nothing and the customer was told it could not be built; the stored cause is shown here. Requesters, stated reasons and data are not shown.</p></div><div className="dialog-actions"><button type="button" className="secondary-button" disabled={loading} onClick={() => { setLoading(true); setReloadKey((key) => key + 1); }}>Refresh</button><a className="secondary-button" href="/admin">Back to admin</a></div></section>
    {error && <div className="lineage-note tone-danger" role="alert">{error}</div>}
    <section className="panel">
      <div className="ops-filter" role="group" aria-labelledby={filterLabelId}>
        <span id={filterLabelId} className="table-muted">Show</span>
        {FILTERS.map(([value, label]) => <button key={value} type="button" className={filter === value ? "primary-button button-small" : "secondary-button button-small"} aria-pressed={filter === value} onClick={() => { if (value !== filter) { setLoading(true); setFilter(value); } }}>{label}</button>)}
      </div>
      <div className="table-card" tabIndex={0} role="region" aria-label="Tenant export builds"><table className="data-table">
        <thead><tr><th>Tenant</th><th>Request</th><th>State</th><th>Attempts</th><th>Last error</th><th>Last change</th></tr></thead>
        <tbody>{loading
          ? <tr><td colSpan={6} className="empty-cell">Loading export builds…</td></tr>
          : items.length
            ? items.map((item) => <tr key={item.requestId}>
              <td><strong>{item.tenantName}</strong><span className="table-secondary">{item.tenantId}</span></td>
              <td><code>{item.requestId}</code><span className="table-secondary">Requested {time(item.requestedAt)}</span></td>
              <td><StatusPill status={item.status === "failed" ? "Failed" : "Retrying"}/>{item.nextAttemptAt && <span className="table-secondary">Next attempt {time(item.nextAttemptAt)}</span>}</td>
              <td>{item.attempts}</td>
              <td>{item.lastError ?? <span className="table-muted">None recorded</span>}</td>
              <td>{time(item.changedAt)}</td>
            </tr>)
            : <tr><td colSpan={6} className="empty-cell">{error ? "Nothing to show." : "No failed or retrying export builds."}</td></tr>}</tbody></table></div>
      {nextCursor && !loading && <button type="button" className="secondary-button" disabled={loadingMore} onClick={() => void more()}>{loadingMore ? "Loading…" : "Show more"}</button>}
    </section>
  </div></main>;
}
