import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
// @ts-expect-error Workflow script runs directly in Node; no declaration file needed.
import { evaluateEnvironmentProtection, evaluateGovernance, MISSING_BYPASS_VISIBILITY, parseReleaseEnvironments, RELEASE_CHECKS, REQUIRED_CHECKS, resolveReleaseGovernanceToken, verifyReleaseGovernance } from '../../ci/release-governance.mjs';
import { readFileSync } from 'node:fs';

function fixture(approvals = 1) {
  const checks = RELEASE_CHECKS.map((name: string, id: number) => ({ name, id, app: { slug: 'github-actions', id: 15368 }, status: 'completed', conclusion: 'success' }));
  const rules = [
    { ruleset_id: 1, type: 'pull_request', parameters: {
      required_approving_review_count: approvals,
      dismiss_stale_reviews_on_push: true,
      require_last_push_approval: approvals > 0,
    } },
    { ruleset_id: 1, type: 'non_fast_forward' }, { ruleset_id: 1, type: 'deletion' },
    { ruleset_id: 1, type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true,
      required_status_checks: REQUIRED_CHECKS.map((context: string) => ({ context, integration_id: 15368 })) } },
  ];
  return { checks, rules, sets: [{ id: 1, enforcement: 'active', bypass_actors: [] }] };
}

test('release gate accepts multi-operator approval governance and successful exact-commit checks', () => {
  const { rules, sets, checks } = fixture();
  assert.equal(evaluateGovernance(rules, sets, checks).passed, true);
});

test('container evidence remains mandatory with the five-context live ruleset', () => {
  const { rules, sets, checks } = fixture(0);
  assert.deepEqual(REQUIRED_CHECKS, ['frontend', 'rate-limit-postgres', 'Analyze TypeScript', 'secret-history', 'forbidden-artifacts']);
  assert.equal(evaluateGovernance(rules, sets, checks).passed, true);
  for (const conclusion of ['failure', 'cancelled', 'skipped', null]) {
    const failed = checks.map((check: { name: string }) => check.name === 'container' ? { ...check, conclusion } : check);
    assert.deepEqual(evaluateGovernance(rules, sets, failed).failures, ['release commit lacks successful GitHub Actions check: container']);
  }
  assert.equal(evaluateGovernance(rules, sets, checks.filter((check: { name: string }) => check.name !== 'container')).passed, false);
});

test('release gate accepts the current solo-maintainer PR policy only when it is non-bypassable', () => {
  const { rules, sets, checks } = fixture(0);
  assert.equal(evaluateGovernance(rules, sets, checks).passed, true);
  assert.equal(evaluateGovernance(rules, [{ ...sets[0], bypass_actors: [{ actor_type: 'RepositoryRole', bypass_mode: 'always' }] }], checks).passed, false);
});

test('bypassable, disabled, malformed and weak multi-operator governance fails closed', () => {
  const { rules, sets, checks } = fixture();
  for (const invalid of [[], [{ id: 1, enforcement: 'active' }], [{ ...sets[0], enforcement: 'evaluate' }],
    [{ ...sets[0], bypass_actors: [{ actor_type: 'RepositoryRole', bypass_mode: 'always' }] }]]) {
    assert.equal(evaluateGovernance(rules, invalid, checks).passed, false);
  }
  const stale = structuredClone(rules);
  stale[0].parameters!.dismiss_stale_reviews_on_push = false;
  assert.equal(evaluateGovernance(stale, sets, checks).passed, false);
  const noLastPush = structuredClone(rules);
  noLastPush[0].parameters!.require_last_push_approval = false;
  assert.equal(evaluateGovernance(noLastPush, sets, checks).passed, false);
});

test('rulesets read without admin visibility fail with an actionable app-permission error', () => {
  const { rules, sets, checks } = fixture();
  const hidden = evaluateGovernance(rules, [{ id: 1, enforcement: 'active' }], checks);
  assert.equal(hidden.passed, false);
  assert.deepEqual(hidden.failures, [MISSING_BYPASS_VISIBILITY]);
  assert.match(MISSING_BYPASS_VISIBILITY, /lacks ruleset admin visibility/);
  assert.match(MISSING_BYPASS_VISIBILITY, /GitHub App/);
  // Partial visibility is still evaluated (and the hidden ruleset stays untrusted).
  const partial = evaluateGovernance([...rules, { ruleset_id: 2, type: 'deletion' }],
    [...sets, { id: 2, enforcement: 'active' }], checks);
  assert.equal(partial.passed, true);
  assert.equal(partial.failures.includes(MISSING_BYPASS_VISIBILITY), false);
});

test('missing, failed, spoofed or newer pending checks cannot borrow a successful result', () => {
  const { rules, sets, checks } = fixture();
  for (const invalid of [checks.slice(1), [{ ...checks[0], conclusion: 'failure' }, ...checks.slice(1)],
    checks.map((check: object) => ({ ...check, app: { slug: 'other-app', id: 15368 } })),
    [...checks, { ...checks[0], id: 1000, status: 'in_progress', conclusion: null }]]) {
    assert.equal(evaluateGovernance(rules, sets, invalid).passed, false);
  }
});

test('release governance refuses long-lived PAT credentials', async () => {
  for (const credential of ['ghp_' + 'a'.repeat(40), 'github_pat_' + 'a'.repeat(60), 'fixture']) {
    await assert.rejects(resolveReleaseGovernanceToken(credential, 'example/repo'), /long-lived PATs are refused/);
  }
});

test('release governance mints a repository-scoped short-lived GitHub App installation token', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const credential = JSON.stringify({
    appId: '123456',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/repos/example/repo/installation')) {
      assert.match(String(new Headers(init?.headers).get('authorization')), /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return new Response(JSON.stringify({ id: 42 }), { status: 200 });
    }
    assert.equal(url, 'https://api.github.com/app/installations/42/access_tokens');
    const body = JSON.parse(String(init?.body)) as { repositories: string[]; permissions: Record<string, string> };
    assert.deepEqual(body.repositories, ['repo']);
    assert.deepEqual(body.permissions, { administration: 'write', contents: 'read', checks: 'read' });
    return new Response(JSON.stringify({ token: 'ghs_' + 'x'.repeat(40) }), { status: 201 });
  };
  const token = await resolveReleaseGovernanceToken(credential, 'example/repo', fakeFetch);
  assert.equal(token, 'ghs_' + 'x'.repeat(40));
  assert.equal(calls.length, 2);
});

test('unauthorized API reads fail rather than assuming governance is configured', async () => {
  await assert.rejects(verifyReleaseGovernance({ GITHUB_REPOSITORY: 'example/repo', GITHUB_SHA: 'a'.repeat(40), GITHUB_TOKEN: 'ghs_' + 'x'.repeat(40) },
    async () => new Response('{}', { status: 403 })), /governance read failed/);
});

const mainOnly = { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } };

test('an environment is accepted only when its deployment branch policy allows exactly the branch main', () => {
  assert.deepEqual(evaluateEnvironmentProtection('prod', mainOnly, [{ id: 1, name: 'main', type: 'branch' }]), []);
  // Older responses carry no `type`; a policy without one is a branch policy.
  assert.deepEqual(evaluateEnvironmentProtection('uat', mainOnly, [{ id: 1, name: 'main' }]), []);
  for (const [environment, policies] of [
    [{ deployment_branch_policy: null }, []],
    [{}, []],
    [{ deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } }, []],
    [{ deployment_branch_policy: { protected_branches: true, custom_branch_policies: true } }, [{ name: 'main', type: 'branch' }]],
    [{ deployment_branch_policy: { protected_branches: false, custom_branch_policies: false } }, []],
    [mainOnly, []],
    [mainOnly, [{ name: 'main', type: 'tag' }]],
    [mainOnly, [{ name: 'main', type: 'branch' }, { name: 'release/*', type: 'branch' }]],
    [mainOnly, [{ name: 'release/*', type: 'branch' }]],
    [mainOnly, [{ name: 'ma*', type: 'branch' }]],
  ] as Array<[object, Array<{ name: string; type?: string }>]>) {
    const failures = evaluateEnvironmentProtection('prod', environment, policies);
    assert.equal(failures.length, 1, JSON.stringify([environment, policies]));
    assert.match(failures[0]!, /GitHub Environment prod/);
  }
  assert.match(evaluateEnvironmentProtection('prod', mainOnly, [{ name: 'a', type: 'branch' }, { name: 'b', type: 'tag' }])[0]!, /found: branch:a, tag:b/);
  assert.match(evaluateEnvironmentProtection('prod', mainOnly, [])[0]!, /found: none/);
});

test('RELEASE_ENVIRONMENTS names only the governed environments', () => {
  assert.deepEqual(parseReleaseEnvironments(undefined), []);
  assert.deepEqual(parseReleaseEnvironments(''), []);
  assert.deepEqual(parseReleaseEnvironments('uat, prod,uat'), ['uat', 'prod']);
  assert.throws(() => parseReleaseEnvironments('uat,staging'), /may only name dev, uat, prod/);
});

test('the installation token asks for environments:read only when environments are verified', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const credential = JSON.stringify({ appId: '1', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
  const requested: Array<Record<string, string>> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    if (String(input).endsWith('/installation')) return new Response(JSON.stringify({ id: 7 }), { status: 200 });
    requested.push((JSON.parse(String(init?.body)) as { permissions: Record<string, string> }).permissions);
    return new Response(JSON.stringify({ token: 'ghs_' + 'y'.repeat(40) }), { status: 201 });
  };
  await resolveReleaseGovernanceToken(credential, 'example/repo', fakeFetch);
  await resolveReleaseGovernanceToken(credential, 'example/repo', fakeFetch, { environments: 'read' });
  assert.deepEqual(requested, [
    { administration: 'write', contents: 'read', checks: 'read' },
    { administration: 'write', contents: 'read', checks: 'read', environments: 'read' },
  ]);
});

function governedApi(environments: Record<string, { environment: object; policies: object[] }>): typeof fetch {
  const { rules, sets, checks } = fixture(0);
  const routes: Record<string, unknown> = {
    'compare/main...': { status: 'identical', ahead_by: 0 },
    'rules/branches/main': rules,
    'rulesets/1': sets[0],
    'check-runs': { check_runs: checks },
  };
  return async (input) => {
    const path = String(input).replace('https://api.github.com/repos/example/repo/', '').split('?')[0]!;
    const env = /^environments\/([a-z]+)(\/deployment-branch-policies)?$/.exec(path);
    if (env) {
      const found = environments[env[1]!];
      if (!found) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(env[2] ? { total_count: found.policies.length, branch_policies: found.policies } : found.environment), { status: 200 });
    }
    const key = Object.keys(routes).find((candidate) => path.startsWith(candidate) || path.endsWith(candidate));
    return key ? new Response(JSON.stringify(routes[key]), { status: 200 }) : new Response('{}', { status: 404 });
  };
}

const governedEnv = { GITHUB_REPOSITORY: 'example/repo', GITHUB_SHA: 'a'.repeat(40), GITHUB_TOKEN: 'ghs_' + 'x'.repeat(40) };

test('release governance verifies each named environment against the live branch policy', async () => {
  const mainOnlyEnvironment = { environment: mainOnly, policies: [{ id: 1, name: 'main', type: 'branch' }] };
  const open = { environment: { deployment_branch_policy: null }, policies: [] };

  assert.deepEqual(await verifyReleaseGovernance(governedEnv, governedApi({})), { passed: true, failures: [] }, 'no environments named: unchanged');
  assert.deepEqual(await verifyReleaseGovernance({ ...governedEnv, RELEASE_ENVIRONMENTS: 'uat,prod' }, governedApi({ uat: mainOnlyEnvironment, prod: mainOnlyEnvironment })), { passed: true, failures: [] });

  const drifted = await verifyReleaseGovernance({ ...governedEnv, RELEASE_ENVIRONMENTS: 'uat,prod' }, governedApi({ uat: mainOnlyEnvironment, prod: open }));
  assert.equal(drifted.passed, false);
  assert.deepEqual(drifted.failures, ['GitHub Environment prod has no deployment branch policy: restrict it to the branch main only']);

  await assert.rejects(verifyReleaseGovernance({ ...governedEnv, RELEASE_ENVIRONMENTS: 'prod' }, governedApi({})), /governance read failed \(404\)/);
  await assert.rejects(verifyReleaseGovernance({ ...governedEnv, RELEASE_ENVIRONMENTS: 'staging' }, governedApi({})), /may only name/);
});

test('every workflow that runs release governance names the environments whose secrets it reads', () => {
  const expected: Record<string, RegExp> = {
    '.github/workflows/build-release.yml': /RELEASE_ENVIRONMENTS: \$\{\{ inputs\.environment \}\}/,
    '.github/workflows/terraform-deploy.yml': /RELEASE_ENVIRONMENTS: \$\{\{ inputs\.environment \}\}/,
    '.github/workflows/cloudflare-zone-policy.yml': /RELEASE_ENVIRONMENTS: uat,prod/,
  };
  for (const [file, pattern] of Object.entries(expected)) {
    const workflow = readFileSync(file, 'utf8');
    const step = /- name: Verify effective release governance[\s\S]*?run: node tools\/ci\/release-governance\.mjs/.exec(workflow)?.[0] ?? '';
    assert.match(step, pattern, file);
  }
});
