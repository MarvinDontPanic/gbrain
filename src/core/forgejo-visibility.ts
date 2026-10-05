/** Forgejo/Gitea's authenticated repository API, bound to the exact HTTPS origin.
 * Credentials remain in Git's native helper; redirects and uncertain responses
 * never authorize a push. No provider token setting or global privacy override.
 */
export type GitCredential = { username: string; password: string };
export type CredentialReader = (url: string, repoDir?: string) => Promise<GitCredential | null>;

export const nativeGitCredential: CredentialReader = async (url, repoDir) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn(['git', ...(repoDir ? ['-C', repoDir] : []), 'credential', 'fill'], {
      stdin: 'pipe', stdout: 'pipe', stderr: 'ignore',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
    });
    timer = setTimeout(() => proc.kill(), 15_000);
    proc.stdin.write(`url=${url}\n\n`);
    proc.stdin.end();
    const body = await new Response(proc.stdout).text();
    if (await proc.exited !== 0) return null;
    const values = Object.fromEntries(body.split('\n').filter((x) => x.includes('=')).map((x) => {
      const at = x.indexOf('='); return [x.slice(0, at), x.slice(at + 1)];
    }));
    if (!values.username || !values.password || /[\r\n\x00]/.test(values.username + values.password)) return null;
    return { username: values.username, password: values.password };
  } catch { return null; }
  finally { clearTimeout(timer); }
};

export async function forgejoVisibility(url: string, repoDir: string | undefined,
  credentialReader: CredentialReader, fetchImpl: typeof fetch, timeoutMs: number,
): Promise<'private' | 'public' | 'unverifiable' | null> {
  let origin: URL;
  try { origin = new URL(url); } catch { return null; }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash) return null;
  const match = /^\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/.exec(origin.pathname);
  if (!match) return null;
  const fullName = `${match[1]}/${match[2]}`;
  const credential = await credentialReader(url, repoDir);
  if (!credential) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${origin.origin}/api/v1/repos/${fullName}`, {
      redirect: 'manual', signal: ctl.signal,
      headers: { Accept: 'application/json', Authorization: 'Basic ' +
        Buffer.from(`${credential.username}:${credential.password}`).toString('base64') },
    });
    if (res.status !== 200 || !res.headers.get('content-type')?.includes('application/json')) return 'unverifiable';
    const repo = await res.json() as Record<string, unknown>;
    const canonical = `${origin.origin}/${fullName}`;
    if (repo.full_name !== fullName || repo.clone_url !== canonical + '.git' || repo.html_url !== canonical ||
        typeof repo.private !== 'boolean') return 'unverifiable';
    return repo.private ? 'private' : 'public';
  } catch { return 'unverifiable'; }
  finally { clearTimeout(timer); }
}
