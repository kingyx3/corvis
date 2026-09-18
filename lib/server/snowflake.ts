import { getServerConfig } from "@/lib/server/config";

export type SnowflakeScalar = string | number | boolean | null;
export type SnowflakeRow = Record<string, SnowflakeScalar>;

type SnowflakeColumn = { name: string };
type SnowflakeResponse = {
  data?: unknown[][];
  resultSetMetaData?: { rowType?: SnowflakeColumn[] };
  statementHandle?: string;
  statementStatusUrl?: string;
  code?: string;
  message?: string;
};

type Binding = { type: "TEXT" | "FIXED" | "REAL" | "BOOLEAN"; value: string };

function binding(value: unknown): Binding {
  if (typeof value === "boolean") return { type: "BOOLEAN", value: value ? "true" : "false" };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "FIXED" : "REAL", value: String(value) };
  return { type: "TEXT", value: value == null ? "" : String(value) };
}

export function mapSnowflakeRows(response: SnowflakeResponse): SnowflakeRow[] {
  const columns = response.resultSetMetaData?.rowType?.map((column) => column.name.toLowerCase()) ?? [];
  return (response.data ?? []).map((row) => Object.fromEntries(columns.map((name, index) => [name, (row[index] ?? null) as SnowflakeScalar])));
}

function normalizeUrl(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

export class SnowflakeSqlApi {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly database?: string;
  private readonly warehouse?: string;
  private readonly role?: string;

  constructor(options?: { baseUrl?: string; token?: string; database?: string; warehouse?: string; role?: string }) {
    const config = getServerConfig();
    this.baseUrl = (options?.baseUrl ?? config.snowflakeSqlApiUrl ?? "").replace(/\/$/, "");
    this.token = options?.token ?? config.snowflakeOauthToken ?? "";
    this.database = options?.database ?? config.snowflakeDatabase;
    this.warehouse = options?.warehouse ?? config.snowflakeWarehouse;
    this.role = options?.role ?? config.snowflakeRole;
    if (!this.baseUrl || !this.token) throw new Error("Snowflake SQL API is not configured");
  }

  private async request(url: string, init?: RequestInit): Promise<{ response: Response; body: SnowflakeResponse }> {
    const response = await fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        "x-snowflake-authorization-token-type": "OAUTH",
        "content-type": "application/json",
        accept: "application/json",
        ...(init?.headers || {}),
      },
      cache: "no-store",
    });
    let body: SnowflakeResponse = {};
    try { body = await response.json() as SnowflakeResponse; } catch { /* Snowflake may return an empty error body. */ }
    if (!response.ok && response.status !== 202) {
      throw new Error(`Snowflake SQL API error ${response.status}${body.message ? `: ${body.message}` : ""}`);
    }
    return { response, body };
  }

  async query(statement: string, values: unknown[] = []): Promise<SnowflakeRow[]> {
    const bindings = Object.fromEntries(values.map((value, index) => [String(index + 1), binding(value)]));
    const { response, body } = await this.request(normalizeUrl(this.baseUrl, "/api/v2/statements"), {
      method: "POST",
      body: JSON.stringify({
        statement,
        timeout: 45,
        database: this.database,
        warehouse: this.warehouse,
        role: this.role,
        bindings: values.length ? bindings : undefined,
      }),
    });

    let current = body;
    if (response.status === 202 || current.statementStatusUrl) {
      const statusUrl = current.statementStatusUrl || `/api/v2/statements/${current.statementHandle}`;
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        const polled = await this.request(normalizeUrl(this.baseUrl, statusUrl));
        current = polled.body;
        if (polled.response.status !== 202) break;
      }
      if (!current.data && current.statementStatusUrl) throw new Error("Snowflake statement timed out before completion");
    }
    return mapSnowflakeRows(current);
  }

  async execute(statement: string, values: unknown[] = []): Promise<void> {
    await this.query(statement, values);
  }

  async health(): Promise<boolean> {
    try {
      const rows = await this.query("SELECT 1 AS OK");
      return rows[0]?.ok === "1" || rows[0]?.ok === 1;
    } catch {
      return false;
    }
  }
}

let singleton: SnowflakeSqlApi | undefined;
export function snowflake(): SnowflakeSqlApi {
  if (!singleton) singleton = new SnowflakeSqlApi();
  return singleton;
}
