export type ServerConfig = {
  environment: "development" | "test" | "production";
  demoMode: boolean;
  authIssuer?: string;
  authAudience?: string;
  trustedAuthProxySecret?: string;
  snowflakeDsn?: string;
  objectStoreBucket?: string;
  searchEndpoint?: string;
};

function truthy(value?: string) { return value === "1" || value === "true"; }

export function getServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const environment = (env.NODE_ENV || "development") as ServerConfig["environment"];
  const demoMode = truthy(env.CORVIS_DEMO_MODE);
  const config: ServerConfig = {
    environment,
    demoMode,
    authIssuer: env.CORVIS_AUTH_ISSUER,
    authAudience: env.CORVIS_AUTH_AUDIENCE,
    trustedAuthProxySecret: env.CORVIS_TRUSTED_AUTH_PROXY_SECRET,
    snowflakeDsn: env.CORVIS_SNOWFLAKE_DSN,
    objectStoreBucket: env.CORVIS_OBJECT_STORE_BUCKET,
    searchEndpoint: env.CORVIS_SEARCH_ENDPOINT,
  };

  if (environment === "production") {
    if (demoMode) throw new Error("CORVIS_DEMO_MODE must be disabled in production");
    const missing = [
      ["CORVIS_AUTH_ISSUER", config.authIssuer],
      ["CORVIS_AUTH_AUDIENCE", config.authAudience],
      ["CORVIS_TRUSTED_AUTH_PROXY_SECRET", config.trustedAuthProxySecret],
      ["CORVIS_SNOWFLAKE_DSN", config.snowflakeDsn],
      ["CORVIS_OBJECT_STORE_BUCKET", config.objectStoreBucket],
      ["CORVIS_SEARCH_ENDPOINT", config.searchEndpoint],
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) throw new Error(`Missing production configuration: ${missing.join(", ")}`);
  }
  return config;
}
