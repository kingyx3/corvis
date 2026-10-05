/**
 * Base URL of a separately hosted API, or "" for same-origin. `NEXT_PUBLIC_*` values are inlined at
 * build time, so this must read the variable literally (see Dockerfile / .env.example).
 */
export function apiBase(): string {
  return (process.env.NEXT_PUBLIC_CORVIS_API_BASE ?? "").replace(/\/$/, "");
}

/** Absolute-or-relative URL for an `/api/v1/...` path, honouring the configured API base. */
export function apiUrl(path: string): string {
  return `${apiBase()}${path}`;
}
