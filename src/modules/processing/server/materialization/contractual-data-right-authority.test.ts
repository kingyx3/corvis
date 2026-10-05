import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function read(path: string): Promise<string> {
  return readFile(path, "utf8");
}

test("contractual rights are Corvis-controlled and tenant resources cannot be manufactured", async () => {
  const migration = (await read("db/postgres/migrations/078_contractual_data_right_authority.sql")).toLowerCase();

  assert.match(migration, /access_policy_resource_belongs_to_tenant/);
  assert.match(migration, /from corvis_source\.document/);
  assert.match(migration, /from corvis_identity\.tenant_entity_name/);
  assert.match(migration, /from corvis_facts\.client_portfolio_fund_position/);
  assert.match(migration, /resource not owned by tenant/);
  assert.match(migration, /contractual data-right mutations require corvis operations authority/);
  assert.match(migration, /apply_data_right_admin_authorized/);
  assert.match(migration, /security definer/);
  assert.match(migration, /contract reference required/);
  assert.match(migration, /resource not owned by target tenant/);
  assert.match(migration, /actorTenantId/i);
  assert.match(migration, /revoke all on function corvis_control\.apply_data_right_admin_authorized/);
});

test("the admin route and form require operations authority, an explicit target tenant and contract provenance", async () => {
  const route = await read("src/app/api/v1/admin/access-policy/route.ts");
  const form = await read("src/modules/admin/ui/governance-forms.tsx");

  assert.match(route, /assertOperationsTenant\(identity, config\)/);
  assert.match(route, /targetTenantId = requiredString\(body\.tenantId/);
  assert.match(route, /operation === "set" && !contractReference/);
  assert.match(route, /apply_data_right_admin_authorized/);
  assert.match(route, /targetTenantId, identity\.tenantId, identity\.subject, identity\.workspaceId/);

  assert.match(form, /const \[tenantId, setTenantId\] = useState\(""\)/);
  assert.match(form, /Target tenant ID/);
  assert.match(form, /operation === "revoke" \|\| contractReference/);
  assert.match(form, /Corvis Operations only/);
});
