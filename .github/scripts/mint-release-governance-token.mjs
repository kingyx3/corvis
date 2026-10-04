import { createSign } from 'node:crypto';
import { appendFile } from 'node:fs/promises';

function base64url(value) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
}

export function createAppJwt(appId, privateKey, now = Math.floor(Date.now() / 1000)) {
  if (!/^\d+$/.test(String(appId ?? ''))) throw new Error('RELEASE_GOVERNANCE_APP_ID must be a numeric GitHub App id');
  if (!String(privateKey ?? '').includes('PRIVATE KEY')) throw new Error('RELEASE_GOVERNANCE_APP_PRIVATE_KEY must be a PEM private key');
  const header = base64url({ alg: 'RS256', typ: 'JWT' });
  const payload = base64url({ iat: now - 60, exp: now + 540, iss: String(appId) });
  const signingInput = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(privateKey).toString('base64url')}`;
}

async function github(path, options, fetchImpl = fetch) {
  const response = await fetchImpl(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options?.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`GitHub App token request failed (${response.status})`);
  return response.json();
}

export async function mintReleaseGovernanceToken(env = process.env, fetchImpl = fetch) {
  const repository = env.GITHUB_REPOSITORY ?? '';
  const appId = env.RELEASE_GOVERNANCE_APP_ID ?? '';
  const privateKey = (env.RELEASE_GOVERNANCE_APP_PRIVATE_KEY ?? '').replace(/\\n/g, '\n');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('GITHUB_REPOSITORY must identify the current repository');

  const jwt = createAppJwt(appId, privateKey);
  const installation = await github(`/repos/${repository}/installation`, {
    headers: { Authorization: `Bearer ${jwt}` },
  }, fetchImpl);
  if (!Number.isSafeInteger(installation?.id) || installation.id < 1) throw new Error('GitHub App installation id is invalid');

  const tokenResponse = await github(`/app/installations/${installation.id}/access_tokens`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repositories: [repository.split('/')[1]],
      permissions: { administration: 'write', contents: 'read', checks: 'read' },
    }),
  }, fetchImpl);
  const token = tokenResponse?.token;
  if (typeof token !== 'string' || token.length < 20) throw new Error('GitHub App returned an invalid installation token');
  return token;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const token = await mintReleaseGovernanceToken();
    console.log(`::add-mask::${token}`);
    const output = process.env.GITHUB_OUTPUT;
    if (!output) throw new Error('GITHUB_OUTPUT is required');
    await appendFile(output, `token=${token}\n`, { encoding: 'utf8', mode: 0o600 });
    console.log('Minted short-lived release-governance GitHub App installation token');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Unable to mint release-governance token');
    process.exitCode = 1;
  }
}
