"use client";

import { useRef } from "react";
import type { DocumentRecord } from "@/core/contracts";
import { Icon } from "@/components/ui/icon";
import { StatusPill } from "@/components/ui/status-pill";
import { useFocusTrap } from "@/components/ui/use-focus-trap";

function completedSteps(status: DocumentRecord["status"]) {
  if (status === "Published") return 5;
  if (status === "Review") return 3;
  if (status === "Extracting") return 2;
  return 1;
}

export function DocumentDrawer({ doc, onClose, onReview, canOpenTrustedData }: { doc: DocumentRecord; onClose: () => void; onReview: () => void; canOpenTrustedData: boolean }) {
  const ref = useRef<HTMLElement | null>(null);
  useFocusTrap(ref, onClose);
  const complete = completedSteps(doc.status);
  const steps = ["Registered & secured", "Document interpreted", "Facts extracted", "Independent review", "Fund-period consolidated"];
  return <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside ref={ref} tabIndex={-1} role="dialog" aria-modal="true" className="document-drawer" aria-label={`Document details for ${doc.name}`}>
    <div className="drawer-head"><div className={`file-tile ${doc.name.endsWith("xlsx") ? "excel" : "pdf"}`} aria-hidden="true">{doc.name.endsWith("xlsx") ? "XLS" : "PDF"}</div><button className="icon-button" aria-label="Close document details" onClick={onClose}><Icon name="close"/></button></div>
    <p className="eyebrow">Document</p><h2>{doc.name}</h2><div className="drawer-status"><StatusPill status={doc.status}/><span>{doc.size}</span><span>{doc.pages || "—"} {doc.name.endsWith("xlsx") ? "sheets" : "pages"}</span></div><hr/>
    <h3>Resolved context</h3><dl className="metadata-grid"><dt>Fund</dt><dd>{doc.fund}</dd><dt>Reporting period</dt><dd>{doc.period}</dd><dt>Document type</dt><dd>{doc.type}</dd><dt>Document ID</dt><dd><code>{doc.id}</code></dd><dt>Source quality</dt><dd>{doc.quality}</dd><dt>Observations</dt><dd>{doc.observations || "Processing"}</dd></dl><hr/>
    <h3>Processing pipeline</h3><ol className="pipeline-list">{steps.map((step, index) => <li key={step} className={index < complete ? "done" : index === complete ? "current" : ""} aria-current={index === complete ? "step" : undefined}><span aria-hidden="true">{index < complete ? <Icon name="check" size={13}/> : index + 1}</span><strong>{step}<span className="visually-hidden">{index < complete ? " (complete)" : index === complete ? " (in progress)" : " (pending)"}</span></strong></li>)}</ol>
    {doc.status === "Published" && canOpenTrustedData && <><hr/><div className="drawer-actions"><button className="primary-button" onClick={onReview}>Open trusted data <Icon name="arrow" size={15}/></button></div></>}
  </aside></div>;
}
