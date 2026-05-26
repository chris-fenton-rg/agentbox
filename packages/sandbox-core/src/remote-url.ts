/**
 * Classify a git remote URL by transport scheme. Used by the credential-
 * forwarding fast paths (relay's git push/fetch, cloud workspace seeding)
 * to pick between SSH agent forwarding, HTTPS credential proxy, or a
 * bundle fallback.
 *
 * - `ssh`   — `ssh://…` or scp-like `user@host:path/to/repo.git`
 * - `https` — `https://…` or `http://…`
 * - `other` — file://, git://, anything we don't have a credential channel for
 */

export type RemoteScheme = 'ssh' | 'https' | 'other';

export function classifyRemoteUrl(url: string): RemoteScheme {
  if (/^ssh:\/\//i.test(url)) return 'ssh';
  // scp-like: user@host:path/to/repo.git
  if (/^[^/@\s]+@[^/:\s]+:[^/]/.test(url)) return 'ssh';
  if (/^https?:\/\//i.test(url)) return 'https';
  return 'other';
}
