import { pathToFileURL } from 'node:url';

export const REQUIRED_CHECKS = ['frontend', 'container', 'rate-limit-postgres', 'Analyze TypeScript', 'secret-history', 'forbidden-artifacts'];

export const MISSING_BYPASS_VISIBILITY = 'Release governance token lacks ruleset admin visibility: GitHub omitted bypass_actors ' +
  'from every applicable ruleset. Configure the RELEASE_GOVERNANCE_TOKEN environment secret with a fine-grained PAT or ' +
  'GitHub App installation token that has repository Administration: read and write (plus Contents: read and Checks: read) ' +
  'on this repository; the workflow GITHUB_TOKEN cannot read ruleset bypass actors. See docs/GITHUB_ENVIRONMENTS.md.';

export function evaluateGovernance(rules, rulesets, checks) {
  const failures = [];
  // GitHub only returns bypass_actors to callers with write access to the
  // ruleset. If no response carries it, the token (not the ruleset) is the
  // problem; say so instead of reporting misleading rule failures. Missing
  // bypass data is still never treated as an empty bypass list.
  if (rulesets.length > 0 && rulesets.every((set) => !Object.hasOwn(set ?? {}, 'bypass_actors'))) {
    return { passed: false, failures: [MISSING_BYPASS_VISIBILITY] };
  }
  // Only credit rules whose applicable ruleset is active and cannot be bypassed.
  // Missing bypass data is not evidence of an empty bypass list.
  const trusted = new Set(rulesets.filter((set) => set.enforcement === 'active' &&
    Array.isArray(set.bypass_actors) && set.bypass_actors.length === 0).map((set) => set.id));
  const enforced = rules.filter((rule) => trusted.has(rule.ruleset_id));

  // Corvis currently operates as a solo-maintainer repository. GitHub cannot
  // require an independent approval without deadlocking that operating model,
  // so release governance accepts either:
  //   * solo mode: PR-only changes + stale-review dismissal + no bypass actors;
  //   * multi-operator mode: the same controls plus >=1 approval and last-push approval.
  // The effective required checks below remain mandatory in both modes. When a
  // second operator is introduced, the live ruleset should move to the latter
  // without requiring a code change here.
  const pullRequestRule = enforced.find((rule) => rule.type === 'pull_request');
  if (!pullRequestRule || pullRequestRule.parameters?.dismiss_stale_reviews_on_push !== true) {
    failures.push('main must require pull requests with stale-review dismissal and no bypass');
  } else {
    const approvals = pullRequestRule.parameters?.required_approving_review_count;
    if (!Number.isInteger(approvals) || approvals < 0) {
      failures.push('main pull-request approval policy is invalid');
    } else if (approvals > 0 && pullRequestRule.parameters?.require_last_push_approval !== true) {
      failures.push('multi-operator approval policy must require last-push approval');
    }
  }

  if (!enforced.some((rule) => rule.type === 'non_fast_forward')) failures.push('main must reject force pushes');
  if (!enforced.some((rule) => rule.type === 'deletion')) failures.push('main must reject deletion');
  const required = enforced.filter((rule) => rule.type === 'required_status_checks' &&
    rule.parameters?.strict_required_status_checks_policy === true)
    .flatMap((rule) => rule.parameters.required_status_checks ?? []);
  for (const name of REQUIRED_CHECKS) {
    const check = checks.filter((entry) => entry.name === name && entry.app?.slug === 'github-actions')
      .sort((a, b) => b.id - a.id)[0];
    if (!check || check.status !== 'completed' || check.conclusion !== 'success') {
      failures.push(`release commit lacks successful GitHub Actions check: ${name}`);
    }
    if (!required.some((entry) => entry.context === name && check && entry.integration_id === check.app.id)) {
      failures.push(`main lacks strict required check bound to GitHub Actions: ${name}`);
    }
  }
  return { passed: failures.length === 0, failures };
}

export async function verifyReleaseGovernance(env = process.env, fetchImpl = fetch) {
  const { GITHUB_REPOSITORY: repository, GITHUB_TOKEN: token } = env;
  const sha = env.RELEASE_SHA || env.GITHUB_SHA;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^[a-f0-9]{40}$/.test(sha ?? '') || !token) {
    throw new Error('Repository, exact release SHA and GitHub token are required (set the RELEASE_GOVERNANCE_TOKEN secret)');
  }
  async function get(path) {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`Release governance read failed (${response.status})`);
    return response.json();
  }
  async function pages(path, field) {
    const values = [];
    for (let page = 1; page <= 20; page += 1) {
      const result = await get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const items = field ? result[field] : result;
      if (!Array.isArray(items)) throw new Error('Malformed release governance response');
      values.push(...items);
      if (items.length < 100) return values;
    }
    throw new Error('Release governance pagination limit exceeded');
  }
  const comparison = await get(`compare/main...${sha}`);
  if (!['identical', 'behind'].includes(comparison.status) || comparison.ahead_by !== 0) {
    throw new Error('Release commit is not on main history');
  }
  const rules = await pages('rules/branches/main');
  const ids = [...new Set(rules.map((rule) => rule.ruleset_id))];
  if (ids.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new Error('Invalid ruleset identity');
  const rulesets = await Promise.all(ids.map((id) => get(`rulesets/${id}?includes_parents=true`)));
  const checks = await pages(`commits/${sha}/check-runs?filter=latest`, 'check_runs');
  return evaluateGovernance(rules, rulesets, checks);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await verifyReleaseGovernance();
    for (const failure of result.failures) console.error(failure);
    if (!result.passed) process.exitCode = 1;
    else console.log('Release source checks and non-bypassable main rules verified');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Release governance verification failed');
    process.exitCode = 1;
  }
}
