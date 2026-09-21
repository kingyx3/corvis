export type RuntimeSurface = "api" | "worker" | "customer" | "admin" | "combined" | "disabled";

const VALID_SURFACES = new Set<RuntimeSurface>(["api", "worker", "customer", "admin", "combined", "disabled"]);

function surfaceFromServiceName(serviceName: string | undefined): RuntimeSurface | null {
  const normalized = serviceName?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith("corvis-api-")) return "api";
  if (normalized.startsWith("corvis-worker-")) return "worker";
  if (normalized.startsWith("corvis-customer-")) return "customer";
  if (normalized.startsWith("corvis-admin-")) return "admin";
  return null;
}

export function resolveRuntimeSurface(
  configured: string | undefined,
  options: { nodeEnv?: string; demoMode?: string; serviceName?: string } = {},
): RuntimeSurface {
  const value = configured?.trim().toLowerCase();
  if (value && VALID_SURFACES.has(value as RuntimeSurface)) return value as RuntimeSurface;

  const derived = surfaceFromServiceName(options.serviceName);
  if (derived) return derived;

  if (options.nodeEnv !== "production" || options.demoMode === "true") return "combined";
  return "disabled";
}

function isStaticPath(pathname: string): boolean {
  return pathname.startsWith("/_next/") || pathname === "/favicon.ico" || pathname === "/robots.txt";
}

export function runtimeSurfaceAllows(surface: RuntimeSurface, pathname: string): boolean {
  if (surface === "combined") return true;
  if (surface === "disabled") return pathname === "/api/v1/health";
  if (pathname === "/api/v1/health") return true;

  if (surface === "worker") return pathname.startsWith("/api/internal/");

  if (surface === "api") {
    return pathname === "/api/v1" || pathname.startsWith("/api/v1/");
  }

  if (surface === "admin") {
    return isStaticPath(pathname)
      || pathname === "/admin"
      || pathname.startsWith("/admin/");
  }

  if (surface === "customer") {
    if (pathname.startsWith("/api/") || pathname === "/admin" || pathname.startsWith("/admin/")) return false;
    return true;
  }

  return false;
}
