"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { NotificationDelivery, NotificationPreferenceSetting, NotificationSettings } from "@/core/notifications";
import { Icon } from "@/components/ui/icon";
import { Modal } from "@/components/ui/modal";
import { workspaceContextHeaders } from "@/lib/workspace-context";

type Draft = Record<string, { enabled: boolean; delivery: NotificationDelivery }>;

const ENDPOINT = "/api/v1/notification-preferences";

async function request(init?: RequestInit): Promise<NotificationSettings> {
  const response = await fetch(ENDPOINT, {
    credentials: "include",
    cache: "no-store",
    ...init,
    headers: { ...workspaceContextHeaders(), accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}) },
  });
  const body = await response.json().catch(() => ({})) as { data?: NotificationSettings; error?: string };
  if (!response.ok || !body.data) throw new Error(body.error === "human_identity_required" ? "Notification settings are only available to people, not service accounts." : "Notification settings could not be loaded. Try again.");
  return body.data;
}

function draftOf(categories: NotificationPreferenceSetting[]): Draft {
  return Object.fromEntries(categories.map((category) => [category.id, { enabled: category.enabled, delivery: category.delivery }]));
}

/**
 * The signed-in person's own email notification settings (#258). Security
 * notices are shown as "Always on" and cannot be changed. When no email
 * provider is active yet the dialog says so rather than implying delivery.
 */
export function NotificationSettingsDialog({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    request().then((loaded) => { if (active) { setSettings(loaded); setDraft(draftOf(loaded.categories)); } })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Notification settings could not be loaded."); });
    return () => { active = false; };
  }, []);

  const update = (id: string, change: Partial<Draft[string]>) => setDraft((current) => ({ ...current, [id]: { ...current[id]!, ...change } }));

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!settings) return;
    const categories = settings.categories.filter((category) => !category.mandatory).map((category) => ({ id: category.id, ...draft[category.id]! }));
    setSaving(true);
    setError(null);
    try {
      await request({ method: "PUT", body: JSON.stringify({ categories }) });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Notification settings could not be saved.");
      setSaving(false);
    }
  };

  return <Modal label="Notification settings" onClose={onClose} width="min(640px, 100%)">
    <form className="dialog-body notification-settings" onSubmit={(event) => void save(event)}>
      <h2>Notification settings</h2>
      {!settings && !error && <p role="status">Loading your notification settings…</p>}
      {settings && <>
        <p className="field-hint">{settings.address
          ? <>Emails go to <strong>{settings.address}</strong>, the verified address from your organization sign-in.</>
          : <>We don&apos;t have a verified email address for you yet. It is taken from your organization sign-in, so it will appear after you next sign in.</>}</p>
        {settings.emailDelivery === "not_configured" && <div className="lineage-note tone-warning" role="status"><Icon name="alert"/><div><strong>Email delivery isn&apos;t switched on yet</strong><span>Your choices are saved and apply as soon as your organization&apos;s email delivery is activated. In-app notices are not affected.</span></div></div>}
        <ul className="notification-settings-list" aria-label="Notification categories">
          {settings.categories.map((category) => {
            const current = draft[category.id] ?? { enabled: category.enabled, delivery: category.delivery };
            const descriptionId = `notification-${category.id}-description`;
            return <li key={category.id} className="notification-settings-row">
              <div className="notification-settings-text"><strong>{category.label}</strong><small id={descriptionId}>{category.description}</small></div>
              {category.mandatory
                ? <span className="notification-locked" aria-describedby={descriptionId}><Icon name="shield" size={14}/>Always on</span>
                : <div className="notification-settings-controls">
                  <label className="check-field"><input type="checkbox" checked={current.enabled} aria-describedby={descriptionId} onChange={(event) => update(category.id, { enabled: event.target.checked })}/><span>Email me<span className="visually-hidden"> about {category.label.toLowerCase()}</span></span></label>
                  <label className="form-field"><span className="visually-hidden">When to email about {category.label.toLowerCase()}</span><select value={current.delivery} disabled={!current.enabled} onChange={(event) => update(category.id, { delivery: event.target.value as NotificationDelivery })}><option value="immediate">Right away</option><option value="daily_digest">Daily summary</option></select></label>
                </div>}
            </li>;
          })}
        </ul>
        <p className="field-hint">Emails never include figures or document content, only a short description and a link back to Corvis.</p>
      </>}
      {error && <div className="lineage-note tone-danger" role="alert"><Icon name="alert"/><div><strong>{error}</strong></div></div>}
      <div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={!settings || saving}>{saving ? "Saving…" : "Save settings"}</button></div>
    </form>
  </Modal>;
}
