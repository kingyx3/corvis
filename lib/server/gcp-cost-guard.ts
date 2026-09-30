import { GoogleOidcVerifier, type GoogleServiceAccountIdentity } from "./gcp-oidc.ts";

const MAX_REQUEST_BYTES = 256 * 1024;
const METADATA_TOKEN_TIMEOUT_MS = 5_000;
export const COST_GUARD_REQUEST_TIMEOUT_MS = 20_000;

export type BudgetGuardConfig = {
  projectId: string;
  region: string;
  environment: string;
  budgetDisplayName: string;
  guardThreshold: number;
  audience: string;
  serviceAccountEmail: string;
  processingQueueName: string;
  schedulerJobNames: string[];
};

export type BudgetUpdate = {
  budgetDisplayName: string;
  costAmount: number;
  budgetAmount: number;
  currencyCode?: string;
};

export type CostGuardAction = {
  kind: "scheduler" | "queue";
  name: string;
  outcome: "paused" | "already_paused" | "not_found" | "disabled";
};

export type BudgetGuardResult = {
  outcome: "ignored" | "below_threshold" | "hibernated";
  ratio?: number;
  reason?: "different_budget";
  actions?: CostGuardAction[];
};

export class BudgetGuardRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "BudgetGuardRequestError";
    this.code = code;
    this.status = status;
  }
}

function required(value: string | undefined, name: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) throw new Error(`${name} is required for the GCP budget guard`);
  return trimmed;
}

export function budgetGuardConfig(env: NodeJS.ProcessEnv = process.env): BudgetGuardConfig {
  const environment = required(env.CORVIS_ENVIRONMENT, "CORVIS_ENVIRONMENT");
  const threshold = Number(env.CORVIS_BUDGET_GUARD_THRESHOLD ?? "0.85");
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new Error("CORVIS_BUDGET_GUARD_THRESHOLD must be greater than 0 and at most 1");
  }
  return {
    projectId: required(env.CORVIS_GCP_PROJECT_ID, "CORVIS_GCP_PROJECT_ID"),
    region: required(env.CORVIS_GCP_REGION, "CORVIS_GCP_REGION"),
    environment,
    budgetDisplayName: required(env.CORVIS_BUDGET_DISPLAY_NAME, "CORVIS_BUDGET_DISPLAY_NAME"),
    guardThreshold: threshold,
    audience: required(env.CORVIS_BUDGET_GUARD_AUDIENCE, "CORVIS_BUDGET_GUARD_AUDIENCE"),
    serviceAccountEmail: required(env.CORVIS_BUDGET_GUARD_SERVICE_ACCOUNT, "CORVIS_BUDGET_GUARD_SERVICE_ACCOUNT"),
    processingQueueName: `processing-${environment}`,
    schedulerJobNames: [
      `corvis-delivery-${environment}`,
      `corvis-control-loop-daily-${environment}`,
      `corvis-control-loop-weekly-${environment}`,
      `corvis-control-loop-monthly-${environment}`,
    ],
  };
}

type PubsubEnvelope = {
  message?: {
    data?: unknown;
    attributes?: Record<string, unknown>;
  };
};

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BudgetGuardRequestError("invalid_budget_update", 400, `${field} must be a finite number`);
  }
  return value;
}

export async function parseBudgetUpdate(request: Request): Promise<BudgetUpdate> {
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) {
    throw new BudgetGuardRequestError("budget_update_too_large", 413, "budget notification exceeds maximum size");
  }

  let envelope: PubsubEnvelope;
  try {
    envelope = JSON.parse(text) as PubsubEnvelope;
  } catch {
    throw new BudgetGuardRequestError("invalid_budget_update", 400, "budget notification is not valid JSON");
  }

  const data = envelope.message?.data;
  if (typeof data !== "string" || !data) {
    throw new BudgetGuardRequestError("invalid_budget_update", 400, "Pub/Sub message.data is required");
  }
  const schemaVersion = envelope.message?.attributes?.schemaVersion;
  if (schemaVersion !== undefined && schemaVersion !== "1.0") {
    throw new BudgetGuardRequestError("unsupported_budget_schema", 400, "budget notification schemaVersion must be 1.0");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(data, "base64").toString("utf8")) as unknown;
  } catch {
    throw new BudgetGuardRequestError("invalid_budget_update", 400, "budget notification data is not valid JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new BudgetGuardRequestError("invalid_budget_update", 400, "budget notification data must be an object");
  }
  const body = payload as Record<string, unknown>;
  if (typeof body.budgetDisplayName !== "string" || !body.budgetDisplayName.trim()) {
    throw new BudgetGuardRequestError("invalid_budget_update", 400, "budgetDisplayName is required");
  }
  if (body.currencyCode !== undefined && body.currencyCode !== "USD") {
    throw new BudgetGuardRequestError("invalid_budget_update", 400, "only USD budget notifications are accepted");
  }
  const budgetAmount = finiteNumber(body.budgetAmount, "budgetAmount");
  if (budgetAmount <= 0) {
    throw new BudgetGuardRequestError("invalid_budget_update", 400, "budgetAmount must be greater than zero");
  }
  return {
    budgetDisplayName: body.budgetDisplayName.trim(),
    costAmount: finiteNumber(body.costAmount, "costAmount"),
    budgetAmount,
    currencyCode: typeof body.currencyCode === "string" ? body.currencyCode : undefined,
  };
}

export interface BudgetControlPort {
  pause(config: BudgetGuardConfig): Promise<CostGuardAction[]>;
}

export type BudgetGuardDependencies = {
  config: BudgetGuardConfig;
  verifyGoogleIdentity(input: {
    authorization: string | null;
    audience: string;
    serviceAccountEmail: string;
  }): Promise<GoogleServiceAccountIdentity>;
  control: BudgetControlPort;
};

export async function executeBudgetGuardRequest(
  request: Request,
  dependencies: BudgetGuardDependencies,
): Promise<BudgetGuardResult> {
  try {
    await dependencies.verifyGoogleIdentity({
      authorization: request.headers.get("authorization"),
      audience: dependencies.config.audience,
      serviceAccountEmail: dependencies.config.serviceAccountEmail,
    });
  } catch {
    throw new BudgetGuardRequestError("budget_guard_authentication_failed", 401, "approved GCP budget-push identity is required");
  }

  const update = await parseBudgetUpdate(request);
  if (update.budgetDisplayName !== dependencies.config.budgetDisplayName) {
    return { outcome: "ignored", reason: "different_budget" };
  }

  const ratio = update.costAmount / update.budgetAmount;
  if (ratio < dependencies.config.guardThreshold) {
    return { outcome: "below_threshold", ratio };
  }
  const actions = await dependencies.control.pause(dependencies.config);
  return { outcome: "hibernated", ratio, actions };
}

type TokenResponse = { access_token?: string; expires_in?: number };

type ResourceResponse = { state?: string };

export class GcpBudgetControlClient implements BudgetControlPort {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private cachedToken?: { value: string; expiresAt: number };

  constructor(options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? COST_GUARD_REQUEST_TIMEOUT_MS;
  }

  private async accessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt - Date.now() > 60_000) return this.cachedToken.value;
    const response = await this.fetchImpl(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" }, cache: "no-store", signal: AbortSignal.timeout(METADATA_TOKEN_TIMEOUT_MS) },
    );
    if (!response.ok) throw new Error(`GCP workload identity token request failed (${response.status})`);
    const body = await response.json() as TokenResponse;
    if (!body.access_token) throw new Error("GCP workload identity did not return an access token");
    this.cachedToken = {
      value: body.access_token,
      expiresAt: Date.now() + Math.max(60, body.expires_in ?? 300) * 1000,
    };
    return body.access_token;
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.accessToken();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (init.method === "POST") headers.set("content-type", "application/json");
    return this.fetchImpl(url, {
      ...init,
      headers,
      body: init.method === "POST" ? init.body ?? "{}" : init.body,
      cache: "no-store",
      signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
    });
  }

  private async pauseScheduler(config: BudgetGuardConfig, name: string): Promise<CostGuardAction> {
    const base = `https://cloudscheduler.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/locations/${encodeURIComponent(config.region)}/jobs/${encodeURIComponent(name)}`;
    const current = await this.request(base);
    if (current.status === 404) return { kind: "scheduler", name, outcome: "not_found" };
    if (!current.ok) throw new Error(`Cloud Scheduler job lookup failed (${current.status}) for ${name}`);
    const state = ((await current.json()) as ResourceResponse).state;
    if (state === "PAUSED") return { kind: "scheduler", name, outcome: "already_paused" };
    if (state === "DISABLED") return { kind: "scheduler", name, outcome: "disabled" };
    if (state !== "ENABLED") throw new Error(`Cloud Scheduler job ${name} is in unexpected state ${String(state)}`);
    const paused = await this.request(`${base}:pause`, { method: "POST" });
    if (!paused.ok) throw new Error(`Cloud Scheduler pause failed (${paused.status}) for ${name}`);
    return { kind: "scheduler", name, outcome: "paused" };
  }

  private async pauseQueue(config: BudgetGuardConfig): Promise<CostGuardAction> {
    const name = config.processingQueueName;
    const base = `https://cloudtasks.googleapis.com/v2/projects/${encodeURIComponent(config.projectId)}/locations/${encodeURIComponent(config.region)}/queues/${encodeURIComponent(name)}`;
    const current = await this.request(base);
    if (current.status === 404) return { kind: "queue", name, outcome: "not_found" };
    if (!current.ok) throw new Error(`Cloud Tasks queue lookup failed (${current.status}) for ${name}`);
    const state = ((await current.json()) as ResourceResponse).state;
    if (state === "PAUSED") return { kind: "queue", name, outcome: "already_paused" };
    if (state === "DISABLED") return { kind: "queue", name, outcome: "disabled" };
    if (state !== "RUNNING") throw new Error(`Cloud Tasks queue ${name} is in unexpected state ${String(state)}`);
    const paused = await this.request(`${base}:pause`, { method: "POST" });
    if (!paused.ok) throw new Error(`Cloud Tasks queue pause failed (${paused.status}) for ${name}`);
    return { kind: "queue", name, outcome: "paused" };
  }

  async pause(config: BudgetGuardConfig): Promise<CostGuardAction[]> {
    const actions: CostGuardAction[] = [];
    for (const job of config.schedulerJobNames) actions.push(await this.pauseScheduler(config, job));
    actions.push(await this.pauseQueue(config));
    return actions;
  }
}

let verifier: GoogleOidcVerifier | undefined;
let controller: GcpBudgetControlClient | undefined;

export async function executeConfiguredBudgetGuardRequest(request: Request): Promise<BudgetGuardResult> {
  if (!verifier) verifier = new GoogleOidcVerifier();
  if (!controller) controller = new GcpBudgetControlClient();
  const config = budgetGuardConfig();
  return executeBudgetGuardRequest(request, {
    config,
    verifyGoogleIdentity: (input) => verifier!.verify(input),
    control: controller,
  });
}
