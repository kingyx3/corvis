"use client";

import { Icon } from "@/components/ui/icon";
import { Modal } from "@/components/ui/modal";
import { useSupportConfig, useSupportRequest } from "@/components/help/use-support-request";
import { helpEntries } from "@/lib/support";

/**
 * The Help menu: Contact support (pre-filled), documentation, service status and release notes. It also
 * shows exactly which identifiers the support request carries, so users can see nothing financial is sent.
 */
export function HelpDialog({ view, onClose }: { view: string; onClose: () => void }) {
  const request = useSupportRequest({ view });
  const entries = helpEntries(useSupportConfig(), request);
  return <Modal label="Help and support" onClose={onClose} width="min(520px, 100%)">
    <div className="dialog-body help-dialog">
      <h2>Help and support</h2>
      <p>Find answers, check service health, or contact the Corvis team.</p>
      <ul className="help-links" aria-label="Help resources">
        {entries.map((entry, index) => <li key={entry.id} className="help-link">
          <a href={entry.href} autoFocus={index === 0} aria-describedby={`help-link-${entry.id}`} {...(entry.opensInNewTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
            {entry.label}{entry.opensInNewTab && <span className="visually-hidden"> (opens in a new tab)</span>}
            <Icon name="arrow" size={16}/>
          </a>
          <small id={`help-link-${entry.id}`}>{entry.description}</small>
        </li>)}
      </ul>
      <section className="help-context" aria-labelledby="help-context-title">
        <h3 id="help-context-title">Included when you contact support</h3>
        {request.contextLines.length > 0 && <ul>{request.contextLines.map((line) => <li key={line}>{line}</li>)}</ul>}
        <p>Identifiers only. No financial data or documents are attached automatically.</p>
      </section>
      <div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>Close</button></div>
    </div>
  </Modal>;
}
