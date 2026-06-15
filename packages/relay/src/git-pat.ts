/**
 * GitHub PAT credential helpers for the control-box relay.
 *
 * A control box has no host SSH agent, no `~/.gitconfig`, and no `gh auth`
 * login — it authenticates to GitHub with a fine-grained PAT held in its env.
 * It also has NO local checkout of any box's repo, so `git push` can't run in a
 * working tree the way the laptop relay does. Instead it materializes a
 * throwaway repo from the bundle the box produced and pushes that to origin
 * over HTTPS with the PAT.
 *
 * The PAT is written into the throwaway repo's remote URL (a temp dir that is
 * deleted immediately after), never into a push argv — so it doesn't leak into
 * a process listing.
 */

import { execa } from 'execa';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Parse any GitHub remote URL (scp-like `git@host:owner/repo`, `ssh://…`, or
 * `https://…`, with or without embedded creds) into `{ host, path }`. Throws on
 * an unrecognized shape.
 */
export function parseGitRemote(origin: string): { host: string; path: string } {
  const trimmed = origin.trim();
  if (trimmed.length === 0) throw new Error('empty git remote URL');

  // URL form first: scheme://[user@]host[:port]/path. Matching this before the
  // scp branch avoids misreading `https://github.com/...` as scp `https:...`.
  const urlForm = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(trimmed);
  const scpForm = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(trimmed);
  let host: string;
  let path: string;
  if (urlForm) {
    host = urlForm[1]!;
    path = urlForm[2]!;
  } else if (scpForm && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    host = scpForm[1]!;
    path = scpForm[2]!;
  } else {
    throw new Error(`unrecognized git remote URL: ${origin}`);
  }
  return { host, path: path.replace(/^\/+/, '') };
}

/**
 * Rewrite any GitHub remote URL into an HTTPS URL carrying the PAT as
 * `x-access-token`. Throws on an unrecognized shape.
 */
export function toAuthedHttpsUrl(origin: string, token: string): string {
  const { host, path } = parseGitRemote(origin);
  return `https://x-access-token:${token}@${host}/${path}`;
}

/**
 * The `[HOST/]OWNER/REPO` slug `gh --repo` expects, derived from a remote URL.
 * github.com is implicit (just `OWNER/REPO`); enterprise hosts are prefixed.
 */
export function repoSlugFromRemote(origin: string): string {
  const { host, path } = parseGitRemote(origin);
  const repo = path.replace(/\.git$/, '');
  return host.toLowerCase() === 'github.com' ? repo : `${host}/${repo}`;
}

export interface PushBundleResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Tip commit pushed (FETCH_HEAD of the bundle), or '' if it couldn't be resolved. */
  tipSha: string;
}

export interface PushBundleArgs {
  /** Host path to the `git bundle` produced inside the box. */
  bundlePath: string;
  /** Branch the bundle carries and we push to origin. */
  branch: string;
  /** Already-authed remote URL (see toAuthedHttpsUrl). */
  remoteUrl: string;
  /** Extra `git push` args passed through from the in-box command. */
  extraArgs?: string[];
}

/**
 * Materialize a throwaway repo from `bundlePath`, then push the branch to
 * `remoteUrl`. Used by the control-box relay, which has no working tree. Pure
 * w.r.t. network only in that the remote can be any git URL (a local bare repo
 * in tests; a PAT-authed GitHub HTTPS URL in production).
 */
export async function pushBundleToRemote(args: PushBundleArgs): Promise<PushBundleResult> {
  const tmp = await mkdtemp(join(tmpdir(), 'agentbox-cb-push-'));
  try {
    await execa('git', ['-C', tmp, 'init', '-q'], { reject: false });
    const fetched = await execa(
      'git',
      ['-C', tmp, 'fetch', '--no-tags', args.bundlePath, args.branch],
      { reject: false },
    );
    if (fetched.exitCode !== 0) {
      return {
        exitCode: fetched.exitCode ?? 1,
        stdout: fetched.stdout ?? '',
        stderr: `fetch from bundle failed: ${fetched.stderr ?? ''}`,
        tipSha: '',
      };
    }
    const rev = await execa('git', ['-C', tmp, 'rev-parse', 'FETCH_HEAD'], { reject: false });
    const tipSha = (rev.stdout ?? '').trim();
    // Token lives in the remote URL (this temp config is deleted in finally),
    // not in the push argv, so it can't be read from a process listing.
    await execa('git', ['-C', tmp, 'remote', 'add', 'origin', args.remoteUrl], { reject: false });
    const pushArgs = [
      '-C',
      tmp,
      'push',
      'origin',
      `FETCH_HEAD:refs/heads/${args.branch}`,
      ...(args.extraArgs ?? []),
    ];
    const push = await execa('git', pushArgs, { reject: false });
    return {
      exitCode: push.exitCode ?? 1,
      stdout: push.stdout ?? '',
      stderr: push.stderr ?? '',
      tipSha,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
