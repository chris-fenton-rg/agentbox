/**
 * Hetzner-side `execGitWithHostCreds`: run `git <argv>` inside a Hetzner box
 * with the host's git credentials forwarded for the duration of one exec.
 *
 * - SSH origins (`git@…` / `ssh://…`): forward the host's SSH agent via
 *   `ssh -A`. The in-box git inherits `SSH_AUTH_SOCK` and authenticates to
 *   the remote (GitHub/GitLab/…) using the keys in the host agent.
 * - HTTPS origins (`https://…` / `http://…`): start a short-lived TCP
 *   listener on host loopback that speaks git's credential-helper protocol
 *   and delegates to `git credential fill`; reverse-forward it into the box
 *   via `ssh -A -R`, and configure git to use a one-shot `nc -N` helper that
 *   tunnels through. Proxy is killed in `finally` so the in-box port is
 *   unreachable as soon as the exec returns.
 * - Other schemes (file://, git://): rejected — caller falls back.
 *
 * Mirrors the relay's git push/fetch fast path in `@agentbox/relay`'s
 * `host-actions.ts`. Kept here (not in sandbox-cloud) because it depends on
 * Hetzner's `sshExecWithAgent` and on the box's SshTargetArgs shape.
 */

import {
  classifyRemoteUrl,
  startHostCredentialProxy,
  type HostCredentialProxy,
} from '@agentbox/sandbox-core';
import type { CloudExecResult } from '@agentbox/core';
import { sshExecWithAgent, type SshTargetArgs } from './ssh-cli.js';

export interface ExecGitWithHostCredsOpts {
  remoteUrl: string;
  hostRepo?: string;
  attemptTimeoutMs?: number;
}

export async function execGitWithHostCreds(
  target: SshTargetArgs,
  gitArgv: string[],
  opts: ExecGitWithHostCredsOpts,
): Promise<CloudExecResult> {
  const scheme = classifyRemoteUrl(opts.remoteUrl);
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? 5 * 60_000;

  if (scheme === 'ssh') {
    if (!process.env['SSH_AUTH_SOCK']) {
      return {
        exitCode: 127,
        stdout: '',
        stderr: 'execGitWithHostCreds: SSH_AUTH_SOCK not set on host; cannot forward ssh agent\n',
      };
    }
    // Force `StrictHostKeyChecking=accept-new` so the in-box ssh accepts the
    // remote (github.com etc.) on first contact instead of dying on ssh-askpass.
    // The box is short-lived; per-host trust pinning makes no sense here.
    const sshOpts = `ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes`;
    const cmd = `GIT_SSH_COMMAND=${shellSingleQuote(sshOpts)} git ${gitArgv.map(shellSingleQuote).join(' ')}`;
    return sshExecWithAgent(target, cmd, { timeoutMs: attemptTimeoutMs });
  }

  if (scheme === 'https') {
    const inboxPort = pickInboxPort();
    let proxy: HostCredentialProxy | undefined;
    try {
      proxy = await startHostCredentialProxy({ hostRepo: opts.hostRepo });
    } catch (err) {
      return {
        exitCode: 127,
        stdout: '',
        stderr: `execGitWithHostCreds: could not start host credential proxy: ${err instanceof Error ? err.message : String(err)}\n`,
      };
    }
    try {
      // Helper body: only respond to `get`; for `store`/`erase` exit 0 silently
      // (this helper is per-invocation, persistence is meaningless). Use
      // OpenBSD `nc -N` so the socket half-closes after stdin EOF, letting
      // the host proxy detect end-of-request and respond.
      const helperBody = `[ "$1" = get ] || exit 0; exec nc -N 127.0.0.1 ${String(inboxPort)}`;
      const helper = `!sh -c ${shellSingleQuote(helperBody)} --`;
      const gitParts = [
        'git',
        // Clear any inherited helpers so only ours is consulted, avoiding
        // slow timeouts against a configured-but-unreachable helper.
        '-c', 'credential.helper=',
        '-c', `credential.helper=${helper}`,
        ...gitArgv,
      ];
      const cmd = gitParts.map(shellSingleQuote).join(' ');
      return await sshExecWithAgent(target, cmd, {
        timeoutMs: attemptTimeoutMs,
        reverseForward: { inboxPort, hostPort: proxy.port },
      });
    } finally {
      await proxy.stop().catch(() => {
        /* best-effort */
      });
    }
  }

  return {
    exitCode: 127,
    stdout: '',
    stderr: `execGitWithHostCreds: unsupported remote scheme '${scheme}' for ${opts.remoteUrl}\n`,
  };
}

/** Pick a random port in the ephemeral range for the `-R` reverse forward. */
function pickInboxPort(): number {
  return 49152 + Math.floor(Math.random() * (65535 - 49152));
}

/** Single-quote shell-quote, escaping internal single quotes via the `'\''` trick. */
function shellSingleQuote(s: string): string {
  if (s.length === 0) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
