import { writeFile } from "node:fs/promises";

const timeoutMs = 15_000;
const environment = process.env.CORVIS_ENVIRONMENT || "unknown";
const customerHostname = process.env.CUSTOMER_HOSTNAME || "";
const adminHostname = process.env.ADMIN_HOSTNAME || "";
const apiHostname = process.env.API_HOSTNAME || "";
const directLoadBalancerStatus = process.env.DIRECT_LOAD_BALANCER_BYPASS_STATUS || "";
const directLoadBalancerExitCode = process.env.DIRECT_LOAD_BALANCER_BYPASS_EXIT_CODE || "";
const directCloudRunStatus = process.env.DIRECT_CLOUD_RUN_BYPASS_STATUS || "";

const checks = [];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(url, init = {}) {
  return fetch(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function check(name, fn) {
  const startedAt = new Date().toISOString();
  try {
    const detail = await fn();
    checks.push({ name, status: "pass", startedAt, detail });
  } catch (error) {
    checks.push({
      name,
      status: "fail",
      startedAt,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function skip(name, detail) {
  checks.push({ name, status: "skip", startedAt: new Date().toISOString(), detail });
}

function assertCloudflare(response, label) {
  invariant(Boolean(response.headers.get("cf-ray")), `${label} did not traverse Cloudflare (missing cf-ray)`);
}

function assertSecurityHeaders(response, label) {
  invariant(response.headers.get("x-content-type-options") === "nosniff", `${label} missing X-Content-Type-Options: nosn`);
  const hsts = response.headers.get("strict-transport-security") || "";
  invariant(/max-age=\d+/.test(hsts), `${label} missing HSTS`);
}

for (const [label, hostname] of [
  ["customer", customerHostname],
  ["admin", adminHostname],
]) {
  if (!hostname) {
    skip(`${label}-edge-https`, `${label} runtime is not yet activated in this environment`);
    continue;
  }

  await check(`${label}-edge-https`, async () => {
    const response = await request(`https://${hostname}/`);
    assertCloudflare(response, label);
    assertSecurityHeaders(response, label);
    invariant(response.status >= 200 && response.status < 500, `${label} returned unexpected status ${response.status}`);
    return { status: response.status, cfRayPresent: true, hstsPresent: true };
  });
}

await check("api-https-and-cache-isolation", async () => {
  invariant(apiHostname, "API hostname is not configured");
  const response = await request(`https://${apiHostname}/api/v1/health`);
  assertCloudflare(response, "api");
  assertSecurityHeaders(response, "api");
  invariant(response.status === 200, `API health returned ${response.status}`);
  invariant((response.headers.get("cache-control") || "").toLowerCase().includes("no-store"), "API health is not marked no-store");
  const cacheStatus = (response.headers.get("cf-cache-status") || "").toUpperCase();
  invariant(!["HIT", "STALE", "REVALIDATED", "UPDATING"].includes(cacheStatus), `API response was shared-cached (${cacheStatus})`);
  return { status: response.status, cacheControl: response.headers.get("cache-control"), cloudflareCacheStatus: cacheStatus || "not-reported", originMtlsPathWorking: true };
});

await check("http-redirects-to-https", async () => {
  invariant(apiHostname, "API hostname is not configured");
  const response = await request(`http://${apiHostname}/api/v1/health`);
  invariant([301, 302, 307, 308].includes(response.status), `HTTP request was not redirected (${response.status})`);
  const location = response.headers.get("location") || "";
  invariant(location.startsWith("https://"), `HTTP redirect did not target HTTPS (${location || "missing location"})`);
  return { status: response.status, httpsLocation: true };
});

await check("csrf-cors-cross-site-block", async () => {
  invariant(apiHostname, "API hostname is not configured");
  const response = await request(`https://${apiHostname}/api/v1/exports`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://security-probe.invalid",
      "sec-fetch-site": "cross-site",
    },
    body: JSON.stringify({ format: "csv" }),
  });
  assertCloudflare(response, "csrf probe");
  invariant(response.status === 403, `cross-site mutation returned ${response.status} instead of 403`);
  return { status: response.status };
});

await check("cloudflare-waf-probe", async () => {
  invariant(apiHostname, "API hostname is not configured");
  const response = await request(`https://${apiHostname}/api/v1/health`, {
    headers: { "x-corvis-security-probe": "waf-block" },
  });
  assertCloudflare(response, "WAF probe");
  invariant(response.status === 403, `WAF probe returned ${response.status} instead of 403`);
  return { status: response.status };
});

await check("cloudflare-rate-limit-probe", async () => {
  invariant(apiHostname, "API hostname is not configured");
  const statuses = [];
  for (let index = 0; index < 7; index += 1) {
    const response = await request(`https://${apiHostname}/api/v1/health`, {
      headers: { "x-corvis-security-probe": "rate-limit" },
    });
    statuses.push(response.status);
  }
  invariant(statuses.slice(0, 5).every((status) => status === 200), `rate probe blocked before threshold: ${statuses.join(",")}`);
  invariant(statuses.slice(5).some((status) => status === 403 || status === 429), `rate probe did not trigger enforcement: ${statuses.join(",")}`);
  return { statuses };
});

await check("direct-load-balancer-origin-mtls-blocked", async () => {
  invariant(directLoadBalancerExitCode, "direct load-balancer mTLS probe did not run");
  invariant(directLoadBalancerStatus === "000", `direct load-balancer request reached HTTP with status ${directLoadBalancerStatus}; expected TLS rejection before HTTP`);
  invariant(directLoadBalancerExitCode !== "0", "direct load-balancer TLS handshake unexpectedly succeeded without a client certificate");
  return {
    httpStatus: directLoadBalancerStatus,
    curlExitCode: Number(directLoadBalancerExitCode),
    protection: "cloudflare-authenticated-origin-pull-mtls",
  };
});

await check("direct-cloud-run-origin-bypass-blocked", async () => {
  invariant(directCloudRunStatus, "direct Cloud Run bypass probe did not run");
  invariant(["403", "404"].includes(directCloudRunStatus), `direct Cloud Run request remained reachable with status ${directCloudRunStatus}`);
  return { status: Number(directCloudRunStatus), protection: "cloud-run-ingress-restriction" };
});

const failed = checks.filter((entry) => entry.status === "fail");
const skipped = checks.filter((entry) => entry.status === "skip");
const passed = checks.filter((entry) => entry.status === "pass");
const evidence = {
  schemaVersion: "corvis.security-acceptance.v3",
  environment,
  checkedAt: new Date().toISOString(),
  source: "github-actions",
  checks,
  summary: { passed: passed.length, failed: failed.length, skipped: skipped.length },
};

await writeFile("security-acceptance-evidence.json", `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

for (const entry of checks) {
  const marker = entry.status === "pass" ? "PASS" : entry.status === "skip" ? "SKIP" : "FAIL";
  console.log(`${marker} ${entry.name}: ${JSON.stringify(entry.detail)}`);
}

if (failed.length > 0) process.exitCode = 1;
