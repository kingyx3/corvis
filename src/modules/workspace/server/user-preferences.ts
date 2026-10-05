import { randomUUID } from "node:crypto";
import type { RequestIdentity } from "../../../shared/domain/enterprise.ts";
import { normalizeDisplayPreferences, type DisplayPreferences } from "../domain/display-preferences.ts";
import { normalizeViewConfiguration, type SavedScreen, type SavedView } from "../domain/saved-views.ts";
import { postgres, type PostgresSqlApi } from "../../../platform/database/postgres.ts";
import { getServerConfig } from "../../../platform/config.ts";
export class PreferenceError extends Error { readonly status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }
const params = (i: RequestIdentity) => [i.tenantId, i.workspaceId, i.authMethod, i.subject];
const owner = "tenant_id=$1::uuid and workspace_id=$2::uuid and auth_method=$3 and subject=$4";
const database = () => postgres(getServerConfig().postgresDsn);
const obj = (v: unknown): Record<string, string> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, string> : {};
function views(raw: unknown): SavedView[] { return Array.isArray(raw) ? raw as SavedView[] : []; }
export async function getUserPreferences(i: RequestIdentity, db: PostgresSqlApi = database()) {
  const rows = await db.query(`select auth_method,subject,saved_views,view_defaults,display_preferences from corvis_control.workspace_user_preference
    where tenant_id=$1::uuid and workspace_id=$2::uuid and ((auth_method=$3 and subject=$4) or saved_views @> '[{"shared":true}]'::jsonb)`, params(i));
  const mine = rows.find((r) => r.auth_method === i.authMethod && r.subject === i.subject);
  const list = rows.flatMap((r) => { const owned = r.auth_method === i.authMethod && r.subject === i.subject; return views(r.saved_views).filter((v) => owned || v.shared).map((v) => ({ ...v, owned })); });
  const display = (await db.query(`select display_preferences from corvis_control.workspace_user_preference where tenant_id=$1::uuid and auth_method=$2 and subject=$3 and display_preferences is not null order by updated_at desc limit 1`, [i.tenantId, i.authMethod, i.subject]))[0]?.display_preferences;
  return { display: display ? normalizeDisplayPreferences(display) : null, views: list, defaults: Object.fromEntries(Object.entries(obj(mine?.view_defaults)).filter(([screen, id]) => list.some((v) => v.screen === screen && v.id === id))) };
}
export async function saveDisplayPreferences(i: RequestIdentity, raw: unknown, db: PostgresSqlApi = database()): Promise<DisplayPreferences> {
  const display = normalizeDisplayPreferences(raw);
  if (!db.transaction) throw new Error("Preference mutation requires transactions");
  await db.transaction(async (tx) => {
    // Serialize updates for this user across workspaces, including newly created rows.
    await tx.query(`select pg_advisory_xact_lock(hashtextextended($1,0))`, [JSON.stringify([i.tenantId,i.authMethod,i.subject])]);
  await tx.execute(`insert into corvis_control.workspace_user_preference (tenant_id,workspace_id,auth_method,subject,display_preferences)
    values ($1::uuid,$2::uuid,$3,$4,$5::jsonb) on conflict (tenant_id,workspace_id,auth_method,subject) do update set display_preferences=excluded.display_preferences,updated_at=now()`, [...params(i), JSON.stringify(display)]);
  await tx.execute(`update corvis_control.workspace_user_preference set display_preferences=$4::jsonb,updated_at=now() where tenant_id=$1::uuid and auth_method=$2 and subject=$3`, [i.tenantId, i.authMethod, i.subject, JSON.stringify(display)]);
  });
  return display;
}
export async function mutateSavedView(i: RequestIdentity, command: Record<string, unknown>, db: PostgresSqlApi = database()) {
  if (!db.transaction) throw new Error("Preference mutation requires transactions");
  return db.transaction(async (tx) => {
    await tx.execute(`insert into corvis_control.workspace_user_preference (tenant_id,workspace_id,auth_method,subject) values ($1::uuid,$2::uuid,$3,$4) on conflict do nothing`, params(i));
    const row = (await tx.query(`select saved_views,view_defaults from corvis_control.workspace_user_preference where ${owner} for update`, params(i)))[0];
    const list = views(row?.saved_views); const defaults = obj(row?.view_defaults);
    const screen = command.screen as SavedScreen;
    if (!["review", "analytics", "documents"].includes(screen)) throw new PreferenceError("invalid_view_screen");
    const found = list.find((v) => v.id === command.id && v.screen === screen);
    const name = () => { if (typeof command.name !== "string" || !command.name.trim() || command.name.length > 80) throw new PreferenceError("invalid_view_name"); return command.name.trim(); };
    if (command.action === "create") {
      if (list.length >= 100) throw new PreferenceError("saved_view_limit");
      list.push({ id: randomUUID(), screen, name: name(), configuration: normalizeViewConfiguration(screen, command.configuration), shared: command.shared === true, owned: true });
    } else if (command.action === "default") {
      const accessible = (await getUserPreferences(i, tx)).views.some((v) => v.id === command.id && v.screen === screen);
      if (command.id !== null && !accessible) throw new PreferenceError("view_not_found", 404);
      if (command.id === null) delete defaults[screen]; else defaults[screen] = String(command.id);
    } else {
      if (!found) throw new PreferenceError("view_not_found", 404);
      if (command.action === "rename") found.name = name();
      else if (command.action === "share" && typeof command.shared === "boolean") found.shared = command.shared;
      else if (command.action === "delete") { list.splice(list.indexOf(found), 1); if (defaults[screen] === found.id) delete defaults[screen]; }
      else throw new PreferenceError("invalid_view_action");
    }
    await tx.execute(`update corvis_control.workspace_user_preference set saved_views=$5::jsonb,view_defaults=$6::jsonb,updated_at=now() where ${owner}`, [...params(i), JSON.stringify(list), JSON.stringify(defaults)]);
    return getUserPreferences(i, tx);
  });
}
