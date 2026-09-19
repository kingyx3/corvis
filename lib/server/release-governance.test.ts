import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Workflow script runs directly in Node; no declaration file needed.
import { evaluateGovernance, REQUIRED_CHECKS, verifyReleaseGovernance } from '../../.github/scripts/release-governance.mjs';

function fixture() {
  const checks = REQUIRED_CHECKS.map((name: string, id: number) => ({ name, id, app: { slug: 'github-actions', id: 15368 }, status: 'completed', conclusion: 'success' }));
  const rules = [
    { ruleset_id: 1, type: 'pull_request', parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, require_last_push_approval: true } },
    { ruleset_id: 1, type: 'non_fast_forward' }, { ruleset_id: 1, type: 'deletion' },
    { ruleset_id: 1, type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true,
      required_status_checks: REQUIRED_CHECKS.map((context: string) => ({ context, integration_id: 15368 })) } },
  ];
  return { checks, rules, sets: [{ id: 1, enforcement: 'active', bypass_actors: [] }] };
}

test('release gate accepts enforced review and successful exact-commit checks', () => {
  const { rules, sets, checks } = fixture();
  assert.equal(evaluateGovernance(rules, sets, checks).passed, true);
});

test('zero-review, bypassable, disabled and missing governance fails closed', () => {
  const { rules, sets, checks } = fixture();
  for (const invalid of [[], [{ id: 1, enforcement: 'active' }], [{ ...sets[0], enforcement: 'evaluate' }],
    [{ ...sets[0], bypass_actors: [{ actor_type: 'RepositoryRole', bypass_mode: 'always' }] }]]) {
    assert.equal(evaluateGovernance(rules, invalid, checks).passed, false);
  }
  const weak = structuredClone(rules);
  weak[0].parameters!.required_approving_review_count = 0;
  assert.equal(evaluateGovernance(weak, sets, checks).passed, false);
});

test('missing, failed, spoofed or newer pending checks cannot borrow a successful result', () => {
  const { rules, sets, checks } = fixture();
  for (const invalid of [checks.slice(1), [{ ...checks[0], conclusion: 'failure' }, ...checks.slice(1)],
    checks.map((check: object) => ({ ...check, app: { slug: 'other-app', id: 15368 } })),
    [...checks, { ...checks[0], id: 1000, status: 'in_progress', conclusion: null }]]) {
    assert.equal(evaluateGovernance(rules, sets, invalid).passed, false);
  }
});

test('unauthorized API reads fail rather than assuming governance is configured', async () => {
  await assert.rejects(verifyReleaseGovernance({ GITHUB_REPOSITORY: 'example/repo', GITHUB_SHA: 'a'.repeat(40), GITHUB_TOKEN: 'fixture' },
    async () => new Response('{}', { status: 403 })), /governance read failed/);
});
