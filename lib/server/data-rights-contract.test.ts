import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(file: string) { return readFile(file, "utf8"); }

test("data rights are server-managed, current, deny-by-default and resolved at the authorization boundary", async () => {
  const migration = (await source("db/postgres/migrations/010_authoritative_data_rights.sql")).toLowerCase();
  const authorization = await source("lib/server/authorization.ts");
  const authorizedRequest = await source("lib/server/authorized-request.ts");

  assert.match(migration, /alter table corvis_control\.data_rights force row level security/);
  assert.match(migration, /data_rights_active_resource_idx/);
  assert.equal(/create policy[^;]+for (insert|update|delete|all)/.test(migration), false, "data rights must have no client mutation policy");

  assert.match(authorization, /from corvis_control\.data_rights dr/);
  assert.match(authorization, /bool_and\(dr\.client_visible\)/, "overlapping current rights must evaluate deny-wins");
  assert.match(authorization, /bool_and\(dr\.source_document_access_allowed\)/);
  assert.match(authorization, /dr\.effective_from <= now\(\)/);
  assert.match(authorization, /dr\.effective_to is null or dr\.effective_to > now\(\)/);
  assert.match(authorization, /dr\.resource_type='workspace'/);

  assert.match(authorizedRequest, /sourceDocumentIds: authorized\.sourceDocumentIds/);
  assert.match(authorizedRequest, /redistributionAllowed: authorized\.redistributionAllowed/);
  assert.equal(/\.\.\.authenticated\.entitlements/.test(authorizedRequest), false, "signed entitlement flags must not be spread into authoritative production rights");
});

test("serving, review, research and export paths retain explicit resource/data-right predicates", async () => {
  const repositories = await source("lib/server/platform-repositories.ts");
  const research = await source("lib/server/research.ts");
  const semanticQuery = await source("lib/server/semantic-query.ts");
  const platform = await source("lib/server/platform.ts");
  const enterprise = await source("core/enterprise.ts");

  assert.match(repositories, /document_id::text in \(select jsonb_array_elements_text\(\$2::jsonb\)\)/);
  assert.match(repositories, /o\.fund_id in \(select jsonb_array_elements_text\(\$2::jsonb\)\)/);
  assert.match(repositories, /r\.document_id::text in \(select jsonb_array_elements_text\(\$3::jsonb\)\)/);
  assert.match(repositories, /o\.observation_id=\$2::uuid[\s\S]*o\.fund_id in[\s\S]*r\.document_id::text in/);

  assert.match(semanticQuery, /const entitledFundIds = \[\.\.\.\(identity\.entitlements\.fundIds \?\? \[\]\)\]\.sort\(\)/);
  assert.match(semanticQuery, /const documentIds = \[\.\.\.\(identity\.entitlements\.documentIds \?\? \[\]\)\]\.sort\(\)/);
  assert.match(semanticQuery, /o\.tenant_id=\$1[\s\S]*o\.fund_id in \(select jsonb_array_elements_text\(\$2::jsonb\)\)[\s\S]*r\.document_id::text in \(select jsonb_array_elements_text\(\$3::jsonb\)\)/);
  assert.match(semanticQuery, /and o\.metric_code=\$4/);

  assert.match(research, /const sourceDocumentIds = identity\.entitlements\.sourceDocumentIds \?\? \[\]/);
  assert.match(research, /sourceDocumentIds\.includes\(hit\.documentId\)/);

  assert.match(platform, /assertRedistributionAllowed\(identity\)/);
  assert.match(enterprise, /identity\.entitlements\.sourceDocumentIds !== undefined/);
});
