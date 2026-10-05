import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
// @ts-expect-error Workflow script runs directly in Node; no declaration file needed.
import { evaluateGovernance, MISSING_BYPASS_VISIBILITY, REQUIRED_CHECKS, resolveReleaseGovernanceToken, verifyReleaseGovernance } from '../ci/release-governance.mjs';

function fixture(approvals = 1) {
  const checks = REQUIRED_CHECKS.map((name: string, id: number) => ({ name, id, app: { slug: 'github-actions', id: 15368 }, status: 'completed', conclusion: 'success' }));
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
