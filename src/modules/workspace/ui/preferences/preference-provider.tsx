"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { DEFAULT_DISPLAY, normalizeDisplayPreferences, type DisplayPreferences } from "@/modules/workspace/domain/display-preferences";
import { type SavedView } from "@/modules/workspace/domain/saved-views";
import { apiUrl } from "@/shared/lib/api-url";
import { workspaceContextHeaders, workspaceStorageKey } from "@/shared/lib/workspace-context";
import { safeGetItem, safeSetItem } from "@/shared/lib/safe-storage";
import { setDisplayPreferences } from "@/shared/lib/display-format";
import { workspacePort } from "@/composition/workspace-services";
import { ApiError, notifySessionExpired } from "@/shared/lib/api-errors";
type Preferences = { display: DisplayPreferences | null; views: SavedView[]; defaults: Record<string, string> };
type Context = Preferences & { ready: boolean; error: string; saveDisplay: (v: DisplayPreferences) => Promise<void>; mutateView: (v: Record<string, unknown>) => Promise<void> };
const EMPTY: Preferences = { display: null, views: [], defaults: {} };
const context = createContext<Context>({ ...EMPTY, ready: false, error: "", saveDisplay: async () => {}, mutateView: async () => {} });
async function request(method: string, body?: unknown) {
  const response = await fetch(apiUrl("/api/v1/user-preferences"), { method, credentials: "include", headers: { ...workspaceContextHeaders(), "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (response.status === 401) notifySessionExpired();
  const payload = await response.json();
  if (!response.ok) throw new ApiError(payload.error ?? "Preferences unavailable", response.status);
  return payload.data;
}
export function PreferenceProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Preferences>(EMPTY);
  const [ready, setReady] = useState(false); const [error, setError] = useState(""); const [demoKey, setDemoKey] = useState("");
  const demo = process.env.NEXT_PUBLIC_CORVIS_DEMO_MODE === "true";
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        let next: Preferences;
        if (demo) {
          const identity = await workspacePort.whoAmI();
          const key = workspaceStorageKey(`corvis:preferences:${identity.subject}`); setDemoKey(key);
          next = JSON.parse(safeGetItem("local", key) ?? "null") ?? EMPTY;
        } else next = await request("GET");
        if (!active) return;
        const display = next.display ?? { ...DEFAULT_DISPLAY, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
        next = { ...next, display: normalizeDisplayPreferences(display) };
        setDisplayPreferences(next.display!); setData(next);
      } catch { if (active) setError("Preferences are unavailable. Retry by reloading this page."); }
      finally { if (active) setReady(true); }
    })();
    return () => { active = false; };
  }, [demo]);
  const apply = (next: Preferences) => { setData(next); if (next.display) setDisplayPreferences(next.display); if (demo) safeSetItem("local", demoKey, JSON.stringify(next)); };
  const saveDisplay = async (display: DisplayPreferences) => {
    normalizeDisplayPreferences(display); if (!demo) await request("PUT", { display }); apply({ ...data, display });
  };
  const mutateView = async (command: Record<string, unknown>) => {
    if (!demo) { const next = await request("POST", command); apply({ ...next, display: next.display ?? data.display }); return; }
    const next = structuredClone(data); const found = next.views.find((v) => v.id === command.id);
    if (command.action === "create") next.views.push({ id: crypto.randomUUID(), screen: command.screen as SavedView["screen"], name: String(command.name), configuration: command.configuration as SavedView["configuration"], shared: command.shared === true, owned: true });
    else if (command.action === "default") { if (command.id === null) delete next.defaults[String(command.screen)]; else next.defaults[String(command.screen)] = String(command.id); }
    else if (!found?.owned) throw new Error("This shared view can only be changed by its owner.");
    else if (command.action === "rename") found.name = String(command.name);
    else if (command.action === "share") found.shared = command.shared === true;
    else if (command.action === "delete") { next.views = next.views.filter((v) => v !== found); if (next.defaults[found.screen] === found.id) delete next.defaults[found.screen]; }
    apply(next);
  };
  return <context.Provider value={{ ...data, ready, error, saveDisplay, mutateView }}>{children}</context.Provider>;
}
export const usePreferences = () => useContext(context);
