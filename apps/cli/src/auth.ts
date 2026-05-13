import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { STATE_DIR } from '@agentbox/sandbox-docker';

export const AUTH_FILE = join(STATE_DIR, 'auth.json');

export interface AuthFile {
  claudeCodeOauthToken?: string;
}

export interface ResolvedClaudeAuth {
  /** Env vars to inject into the box. Only includes keys with non-empty string values. */
  env: Record<string, string>;
  /** Where the value(s) came from. `'none'` means there's nothing to forward and the caller may prompt. */
  source: 'host-env' | 'auth-file' | 'none';
}

/**
 * Merge host env + ~/.agentbox/auth.json into a single effective env that the
 * `claude` command forwards to the box. Env wins over the file; either of the
 * two known keys (API key or OAuth token) counts as having auth.
 */
export async function resolveClaudeAuth(
  processEnv: NodeJS.ProcessEnv,
  opts: { authFilePath?: string } = {},
): Promise<ResolvedClaudeAuth> {
  const env: Record<string, string> = {};
  const envApiKey = processEnv['ANTHROPIC_API_KEY'];
  const envOauth = processEnv['CLAUDE_CODE_OAUTH_TOKEN'];
  if (typeof envApiKey === 'string' && envApiKey.length > 0) env['ANTHROPIC_API_KEY'] = envApiKey;
  if (typeof envOauth === 'string' && envOauth.length > 0) env['CLAUDE_CODE_OAUTH_TOKEN'] = envOauth;
  if (Object.keys(env).length > 0) return { env, source: 'host-env' };

  const file = await readAuthFile(opts.authFilePath);
  if (file.claudeCodeOauthToken && file.claudeCodeOauthToken.length > 0) {
    return {
      env: { CLAUDE_CODE_OAUTH_TOKEN: file.claudeCodeOauthToken },
      source: 'auth-file',
    };
  }
  return { env: {}, source: 'none' };
}

export async function readAuthFile(path: string = AUTH_FILE): Promise<AuthFile> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const t = (parsed as { claudeCodeOauthToken?: unknown }).claudeCodeOauthToken;
      return typeof t === 'string' && t.length > 0 ? { claudeCodeOauthToken: t } : {};
    }
    return {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    // A garbage / corrupted file shouldn't kill `agentbox claude`. Treat as empty.
    return {};
  }
}

export async function writeAuthFile(next: AuthFile, path: string = AUTH_FILE): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'w' });
}

/** True iff a `claude` binary is on the host PATH. */
export function hostClaudeAvailable(): boolean {
  // POSIX `command -v` would also work but needs a shell; `which` is in both
  // macOS base and any Linux box we'd realistically run on. We don't shell out
  // to claude itself — that would launch the binary unnecessarily.
  const r = spawnSync('which', ['claude'], { stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 && (r.stdout?.toString().trim().length ?? 0) > 0;
}

/**
 * Run `claude setup-token` interactively. We inherit stdio so the user's
 * terminal drives the OAuth flow (browser open, code paste, etc.) just as if
 * they ran the command themselves. Returns the child exit code.
 */
export function runHostSetupToken(): { exitCode: number } {
  const child = spawnSync('claude', ['setup-token'], { stdio: 'inherit' });
  return { exitCode: child.status ?? -1 };
}

/**
 * Cheap shape check. Anthropic OAuth tokens currently look like
 * `sk-ant-oat01-…`. We don't validate cryptographically — if the user pastes
 * something nonsensical, the box itself will surface "invalid token" when
 * claude tries to use it. Better to save the typo than to block on a
 * regex that could go stale.
 */
export function isPlausibleOauthToken(s: string): boolean {
  const t = s.trim();
  return t.startsWith('sk-ant-oat') && t.length >= 40;
}
