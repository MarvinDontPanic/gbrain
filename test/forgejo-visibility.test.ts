import { expect, test } from 'bun:test';
import { verifyRepoVisibility } from '../src/core/repo-visibility.ts';
const originUrl = 'https://forge.example.test/alice-example/private-notes.git';
const credentialReader = async () => ({ username: 'alice-example', password: 'fixture-only' });
function probe(privateValue: unknown, overrides = {}) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe('https://forge.example.test/api/v1/repos/alice-example/private-notes');
    expect(init?.redirect).toBe('manual');
    expect(new Headers(init?.headers).get('authorization')).toBe('Basic ' + btoa('alice-example:fixture-only'));
    return Response.json({ private: privateValue, full_name: 'alice-example/private-notes',
      clone_url: originUrl, html_url: originUrl.slice(0, -4), ...overrides });
  }) as typeof fetch;
}
test('Forgejo proves private through authenticated same-origin repository metadata', async () => {
  const v = await verifyRepoVisibility({ originUrl, credentialReader, fetchImpl: probe(true) });
  expect(v.verdict).toBe('private');
  expect(JSON.stringify(v)).not.toContain('fixture-only');
});
test('Forgejo public repository is refused, not inferred private from a login wall', async () => {
  expect((await verifyRepoVisibility({ originUrl, credentialReader, fetchImpl: probe(false) })).verdict).toBe('public');
});
test.each([{ full_name: 'someone/else' }, { clone_url: 'https://elsewhere.example.test/a/b.git' },
  { html_url: 'https://elsewhere.example.test/a/b' }, { private: 'true' }])('Forgejo mismatched/invalid metadata fails closed: %j', async (overrides) => {
  expect((await verifyRepoVisibility({ originUrl, credentialReader, fetchImpl: probe(true, overrides) })).verdict).toBe('unverifiable');
});
test('Forgejo network exceptions fail closed without exposing credential values', async () => {
  const v = await verifyRepoVisibility({ originUrl, credentialReader,
    fetchImpl: (async () => { throw new Error('network failure fixture-only'); }) as unknown as typeof fetch });
  expect(v.verdict).toBe('unverifiable');
  expect(JSON.stringify(v)).not.toContain('fixture-only');
});
test.each([302, 401, 403, 404, 500])('Forgejo HTTP %i fails closed', async (status) => {
  expect((await verifyRepoVisibility({ originUrl, credentialReader,
    fetchImpl: (async () => new Response('', { status })) as unknown as typeof fetch })).verdict).toBe('unverifiable');
});
test('No credential means no private verdict and no authenticated request', async () => {
  const v = await verifyRepoVisibility({ originUrl, credentialReader: async () => null,
    runner: async () => ({ code: 1, stdout: '', stderr: '' }), fetchImpl: (() => { throw new Error('must not fetch'); }) as unknown as typeof fetch });
  expect(v.verdict).toBe('unverifiable');
});
