import { getConfig } from "@/server/config";
import { sha256Hex } from "@/server/security";

type BindingValue = string | number | boolean | null;
type SnowflakeResponse = {
  data?: Array<Array<string | null>>;
  statementHandle?: string;
  statementStatusUrl?: string;
  resultSetMetaData?: { rowType?: Array<{ name: string; type?: string }> };
  message?: string;
  code?: string;
};

export type CortexSearchResult = {
  chunk_id: string;
  document_id: string;
  source_reference_id: string;
  text: string;
  page_number?: number;
  fund_id?: string;
  tenant_id?: string;
};

function inferBinding(value: BindingValue): { type: string; value: string | null } {
  if (value === null) return { type: "TEXT", value: null };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "FIXED" : "REAL", value: String(value) };
  if (typeof value === "boolean") return { type: "BOOLEAN", value: value ? "true" : "false" };
  return { type: "TEXT", value };
}

function mapRows<T>(payload: SnowflakeResponse): T[] {
  const columns = payload.resultSetMetaData?.rowType?.map((column) => column.name.toLowerCase()) || [];
  return (payload.data || []).map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])) as T);
}

export function tenantRole(tenantId: string): string {
  return `CORVIS_TENANT_${sha256Hex(tenantId).slice(0, 16).toUpperCase()}`;
}

async function snowflakeFetch(path: string, init: RequestInit): Promise<Response> {
  const config = getConfig().snowflake;
  return fetch(`${config.accountUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
      "X-Snowflake-Authorization-Token-Type": "PROGRAMMATIC_ACCESS_TOKEN",
      ...(init.headers || {}),
    },
    cache: "no-store",
    signal: init.signal || AbortSignal.timeout(30_000),
  });
}

async function awaitStatement(handle: string): Promise<SnowflakeResponse> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await snowflakeFetch(`/api/v2/statements/${encodeURIComponent(handle)}`, { method: "GET" });
    if (response.status === 202) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000 + attempt * 100, 3000)));
      continue;
    }
    const payload = await response.json() as SnowflakeResponse;
    if (!response.ok) throw new Error(`Snowflake statement failed (${response.status}): ${payload.message || payload.code || "unknown error"}`);
    return payload;
  }
  throw new Error("Snowflake statement timed out");
}

export async function query<T = Record<string, string | null>>(
  statement: string,
  bindings: BindingValue[] = [],
  options: { tenantId?: string; admin?: boolean; timeoutSeconds?: number } = {},
): Promise<T[]> {
  const config = getConfig();
  if (config.demoMode) return [];
  const role = options.admin ? config.snowflake.adminRole : options.tenantId ? tenantRole(options.tenantId) : config.snowflake.adminRole;
  const body = {
    statement,
    timeout: options.timeoutSeconds || 60,
    database: config.snowflake.database,
    warehouse: config.snowflake.warehouse,
    role,
    bindings: Object.fromEntries(bindings.map((binding, index) => [String(index + 1), inferBinding(binding)])),
    parameters: { QUERY_TAG: JSON.stringify({ application: "corvis", tenant: options.tenantId || "platform" }) },
  };
  const response = await snowflakeFetch("/api/v2/statements", { method: "POST", body: JSON.stringify(body) });
  let payload = await response.json() as SnowflakeResponse;
  if (response.status === 202 && payload.statementHandle) payload = await awaitStatement(payload.statementHandle);
  else if (!response.ok) throw new Error(`Snowflake query failed (${response.status}): ${payload.message || payload.code || "unknown error"}`);
  return mapRows<T>(payload);
}

export async function execute(statement: string, bindings: BindingValue[] = [], options: { tenantId?: string; admin?: boolean } = {}): Promise<void> {
  await query(statement, bindings, options);
}

export async function cortexSearch(tenantId: string, searchText: string, limit = 8): Promise<CortexSearchResult[]> {
  const config = getConfig();
  if (config.demoMode) return [];
  const { searchDatabase, searchSchema, searchService } = config.snowflake;
  const path = `/api/v2/databases/${encodeURIComponent(searchDatabase)}/schemas/${encodeURIComponent(searchSchema)}/cortex-search-services/${encodeURIComponent(searchService)}:query`;
  const response = await snowflakeFetch(path, {
    method: "POST",
    body: JSON.stringify({
      query: searchText,
      columns: ["chunk_id", "document_id", "source_reference_id", "text", "page_number", "fund_id", "tenant_id"],
      filter: {
        "@and": [
          { "@eq": { tenant_id: tenantId } },
          { "@eq": { source_document_access_allowed: true } },
        ],
      },
      limit: Math.max(1, Math.min(limit, 20)),
    }),
  });
  const payload = await response.json() as { results?: CortexSearchResult[]; message?: string };
  if (!response.ok) throw new Error(`Cortex Search failed (${response.status}): ${payload.message || "unknown error"}`);
  return (payload.results || []).filter((row) => row.tenant_id === undefined || row.tenant_id === tenantId);
}

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
};

export type ChatCompletion = {
  choices?: Array<{ message?: ChatMessage; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string };
};

export async function chatCompletion(input: {
  messages: ChatMessage[];
  tools?: unknown[];
  responseFormat?: unknown;
  temperature?: number;
}): Promise<ChatCompletion> {
  const config = getConfig();
  if (config.demoMode) throw new Error("Cortex model gateway is disabled in demo mode");
  const response = await snowflakeFetch("/api/v2/cortex/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: config.snowflake.model,
      messages: input.messages,
      tools: input.tools,
      response_format: input.responseFormat,
      temperature: input.temperature ?? 0.1,
    }),
  });
  const payload = await response.json() as ChatCompletion;
  if (!response.ok) throw new Error(`Cortex model request failed (${response.status}): ${payload.error?.message || "unknown error"}`);
  return payload;
}
