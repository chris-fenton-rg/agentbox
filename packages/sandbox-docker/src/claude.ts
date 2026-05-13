import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { clearInstallMethod, filterHostHooks } from './claude-hooks-filter.js';
import { ensureVolume, volumeExists } from './docker.js';

export const SHARED_CLAUDE_VOLUME = 'agentbox-claude-config';
export const DEFAULT_CLAUDE_SESSION = 'claude';
const CONTAINER_CLAUDE_DIR = '/home/vscode/.claude';
const CONTAINER_USER = 'vscode';

export interface ClaudeConfigSpec {
  /** Resolved Docker volume name mounted at /home/vscode/.claude. */
  volume: string;
}

export function resolveClaudeVolume(opts: { isolate: boolean; boxId: string }): ClaudeConfigSpec {
  if (opts.isolate) {
    return { volume: `${SHARED_CLAUDE_VOLUME}-${opts.boxId}` };
  }
  return { volume: SHARED_CLAUDE_VOLUME };
}

export interface EnsureClaudeVolumeOptions {
  /**
   * When true and the host's ~/.claude exists, rsync host -> volume on every call.
   * Sync is additive: files present on host overwrite same-named files in the
   * volume; box-only files (e.g. `projects/<hash>/*.jsonl` session history written
   * inside earlier boxes) are preserved.
   */
  syncFromHost: boolean;
  /** Image used by the throwaway sync helper container; we use the box image to avoid extra pulls. */
  image: string;
}

export interface EnsureClaudeVolumeResult {
  /** True only the very first time the volume is created (on this host). */
  created: boolean;
  /** True when the rsync helper actually ran (syncFromHost was true AND host ~/.claude existed). */
  synced: boolean;
  /**
   * Number of hook entries dropped during sync because their `command` pointed
   * at a host path (under `$HOME/`) that wouldn't exist inside the container.
   * 0 when nothing was filtered or no sync ran.
   */
  filteredHookCount?: number;
  /**
   * True when the synced `_claude.json` had its top-level `installMethod`
   * field scrubbed (host had it set; we let in-box claude redetect).
   */
  clearedInstallMethod?: boolean;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the named volume exists, then (when {@link EnsureClaudeVolumeOptions.syncFromHost}
 * is true and the host has a `~/.claude` directory) rsync host -> volume via a throwaway
 * helper container. The host is treated as the authoritative source for config:
 * settings, auth token, skills, plugins, and MCP entries on the host overwrite the
 * same-named files in the volume on every call. Files that only exist in the volume
 * (in-box session history under `projects/`, statsig cache, etc.) are preserved —
 * rsync runs without `--delete`.
 *
 * Caveat: if another box is currently running with the same shared volume mounted,
 * the rsync can change config files under it mid-session. We accept this as part of
 * "host is authoritative" — per-box state under `projects/` is untouched, so the
 * effect is limited to overlapping config files (rare to be edited live).
 *
 * Returns `created: true` only on the very first run for this volume; `synced: true`
 * whenever the rsync actually executed.
 */
export async function ensureClaudeVolume(
  spec: ClaudeConfigSpec,
  opts: EnsureClaudeVolumeOptions,
): Promise<EnsureClaudeVolumeResult> {
  const existed = await volumeExists(spec.volume);
  await ensureVolume(spec.volume);
  const created = !existed;

  if (!opts.syncFromHost) return { created, synced: false };

  const hostClaude = join(homedir(), '.claude');
  if (!(await pathExists(hostClaude))) return { created, synced: false };

  // rsync (not cp -a) so repeat syncs skip unchanged files. rsync is installed in
  // the box image (Dockerfile.box). Trailing slash on /src-claude/ means
  // "contents of src", matching the original cp -a /src/. /dst/ semantics.
  // We run as root (--user 0) because the volume's existing content may be a
  // mix of UIDs (host's macOS UID for files copied from ~/.claude, plus
  // vscode's UID 1000 for anything claude wrote inside a box); only root can
  // rewrite arbitrary ownership. The post-chown brings everything back to
  // UID 1000 so the in-box vscode user can read/write.
  //
  // We also pull in ~/.claude.json (the *file* at home root that Claude Code
  // uses for global state: hasCompletedOnboarding, anonymousId, oauthAccount,
  // plugin caches). It's not inside ~/.claude, so we bind-mount it separately
  // (when present) and copy it into the volume as _claude.json. A symlink
  // baked into the image (/home/vscode/.claude.json -> .../_claude.json)
  // makes it reachable from the path claude expects.
  const hostClaudeJson = join(homedir(), '.claude.json');
  const hasJson = await pathExists(hostClaudeJson);
  const args: string[] = [
    'run',
    '--rm',
    '--user',
    '0',
    '-v',
    `${spec.volume}:/dst`,
    '-v',
    `${hostClaude}:/src-claude:ro`,
  ];
  if (hasJson) args.push('-v', `${hostClaudeJson}:/src-claude-json:ro`);

  // Pre-filter host-path hooks. Hook commands whose path is under the user's
  // host home (e.g. `/Users/marco/.config/iterm2/cc-status`) won't exist
  // inside the Linux container, and Claude logs a noisy
  // `SessionStart:startup hook error /bin/sh: …: not found` every time. We
  // build a small tempdir with filtered copies of `settings.json` /
  // `.claude.json`, mount it as `/src-filter`, and let the helper container
  // overlay it on top of what rsync brought in. The host files are never
  // touched.
  const hostHome = homedir();
  const filterDir = await mkdtemp(join(tmpdir(), 'agentbox-claude-filter-'));
  let filteredHookCount = 0;
  let clearedInstallMethod = false;
  try {
    const settingsResult = await maybeFilterTo(
      join(hostClaude, 'settings.json'),
      join(filterDir, 'settings.json'),
      hostHome,
    );
    filteredHookCount += settingsResult.removedHooks;
    if (hasJson) {
      const jsonResult = await maybeFilterTo(
        hostClaudeJson,
        join(filterDir, '_claude.json'),
        hostHome,
        { clearInstallMethod: true },
      );
      filteredHookCount += jsonResult.removedHooks;
      clearedInstallMethod = jsonResult.clearedInstallMethod;
    }
    if (filteredHookCount > 0 || clearedInstallMethod) {
      args.push('-v', `${filterDir}:/src-filter:ro`);
    }
    args.push(
      opts.image,
      'sh',
      '-c',
      // Each step in its own brace group so a missing optional file (no
      // .claude.json on host, no filtered overlays) doesn't short-circuit the
      // final chown.
      'rsync -a /src-claude/ /dst/' +
        ' && { [ -f /src-claude-json ] && cp -a /src-claude-json /dst/_claude.json; true; }' +
        ' && { [ -f /src-filter/settings.json ] && cp -a /src-filter/settings.json /dst/settings.json; true; }' +
        ' && { [ -f /src-filter/_claude.json ] && cp -a /src-filter/_claude.json /dst/_claude.json; true; }' +
        ' && chown -R 1000:1000 /dst',
    );
    await execa('docker', args);
  } finally {
    await rm(filterDir, { recursive: true, force: true });
  }

  return { created, synced: true, filteredHookCount, clearedInstallMethod };
}

/**
 * Read a JSON file, run it through {@link filterHostHooks} and (when opted in)
 * {@link clearInstallMethod}, and write the result to `dest` ONLY when at
 * least one change was made. Tolerant of missing or garbage JSON — silently
 * returns zero changes in those cases (sync proceeds with the raw rsync'd
 * file).
 */
async function maybeFilterTo(
  src: string,
  dest: string,
  hostHome: string,
  opts: { clearInstallMethod?: boolean } = {},
): Promise<{ removedHooks: number; clearedInstallMethod: boolean }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(src, 'utf8'));
  } catch {
    return { removedHooks: 0, clearedInstallMethod: false };
  }
  const filtered = filterHostHooks(parsed, hostHome);
  let working: unknown = filtered.data;
  let cleared = false;
  if (opts.clearInstallMethod) {
    const r = clearInstallMethod(working);
    working = r.data;
    cleared = r.cleared;
  }
  if (filtered.removedCommands.length === 0 && !cleared) {
    return { removedHooks: 0, clearedInstallMethod: false };
  }
  await writeFile(dest, JSON.stringify(working, null, 2));
  return { removedHooks: filtered.removedCommands.length, clearedInstallMethod: cleared };
}

export interface ClaudeMountResult {
  /** Docker -v spec strings to append to runBox(extraVolumes). */
  extraVolumes: string[];
  /** Env vars to forward into the container; only includes keys that were set + non-empty on the host. */
  env: Record<string, string>;
  volumeName: string;
}

const FORWARDED_ENV_KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;

export function buildClaudeMounts(
  spec: ClaudeConfigSpec,
  hostEnv: NodeJS.ProcessEnv,
): ClaudeMountResult {
  const env: Record<string, string> = {};
  for (const k of FORWARDED_ENV_KEYS) {
    const v = hostEnv[k];
    if (typeof v === 'string' && v.length > 0) env[k] = v;
  }
  return {
    extraVolumes: [`${spec.volume}:${CONTAINER_CLAUDE_DIR}`],
    env,
    volumeName: spec.volume,
  };
}

export class ClaudeSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeSessionError';
  }
}

export interface StartClaudeSessionOptions {
  container: string;
  claudeArgs: string[];
  sessionName?: string;
}

/**
 * Single-quote a token for /bin/sh. Conservative: anything outside the safe alphabet
 * gets wrapped. We don't try to detect "obviously safe" inputs; quoting is cheap.
 */
function shQuote(arg: string): string {
  if (arg.length === 0) return `''`;
  if (/^[A-Za-z0-9_\-./=:@%+,]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Start a detached tmux session running Claude Code inside the container. The session
 * survives client disconnects; reattach via {@link attachClaudeSession}.
 *
 * We forward the host's TERM (default xterm-256color) so the in-container tmux
 * picks the right terminal-overrides at session creation time — without this,
 * docker exec defaults TERM to `xterm` and tmux can't declare 24-bit color.
 */
export async function startClaudeSession(opts: StartClaudeSessionOptions): Promise<void> {
  const sessionName = opts.sessionName ?? DEFAULT_CLAUDE_SESSION;
  const cmd = ['claude', ...opts.claudeArgs].map(shQuote).join(' ');
  const term = process.env['TERM'] ?? 'xterm-256color';
  const result = await execa(
    'docker',
    [
      'exec',
      '-e',
      `TERM=${term}`,
      '--user',
      CONTAINER_USER,
      opts.container,
      'tmux',
      'new-session',
      '-d',
      '-s',
      sessionName,
      cmd,
    ],
    { reject: false },
  );
  if (result.exitCode === 0) return;
  const stderr = (result.stderr ?? '').toString();
  if (result.exitCode === 127 || /command not found|tmux: not found/i.test(stderr)) {
    throw new ClaudeSessionError(
      `tmux is missing from the box image. Rebuild with: docker rmi agentbox/box:dev && retry.`,
    );
  }
  if (/claude.*not found|exec: "claude"/i.test(stderr)) {
    throw new ClaudeSessionError(
      `claude is missing from the box image. Rebuild with: docker rmi agentbox/box:dev && retry.`,
    );
  }
  if (/duplicate session/i.test(stderr)) {
    throw new ClaudeSessionError(
      `a tmux session "${sessionName}" already exists in ${opts.container}; use \`agentbox claude attach\` to reattach.`,
    );
  }
  throw new ClaudeSessionError(
    `failed to start claude session in ${opts.container}: ${stderr.trim() || `exit ${String(result.exitCode)}`}`,
  );
}

/**
 * Replace the current process with `docker exec -it tmux attach`. Ctrl-b d returns
 * the user to their host shell with exit 0. We forward TERM so tmux declares
 * the outer terminal's true-color and hyperlink capabilities; without it
 * docker exec sets TERM=xterm and Claude renders without RGB.
 */
export function attachClaudeSession(container: string, sessionName?: string): never {
  const name = sessionName ?? DEFAULT_CLAUDE_SESSION;
  const term = process.env['TERM'] ?? 'xterm-256color';
  const child = spawnSync(
    'docker',
    [
      'exec',
      '-it',
      '-e',
      `TERM=${term}`,
      '--user',
      CONTAINER_USER,
      container,
      'tmux',
      'attach',
      '-t',
      name,
    ],
    { stdio: 'inherit' },
  );
  process.exit(child.status ?? 0);
}

export interface ClaudeSessionInfo {
  running: boolean;
  sessionName: string;
  /** ISO-8601 timestamp from tmux's `#{session_created}` format string, or null when not running. */
  startedAt: string | null;
}

/**
 * Best-effort: returns `{ running: false, …, startedAt: null }` for any non-zero exit
 * from `tmux has-session` (which includes "no server running" and "no such session").
 */
export async function claudeSessionInfo(
  container: string,
  sessionName?: string,
): Promise<ClaudeSessionInfo> {
  const name = sessionName ?? DEFAULT_CLAUDE_SESSION;
  const has = await execa(
    'docker',
    ['exec', '--user', CONTAINER_USER, container, 'tmux', 'has-session', '-t', name],
    { reject: false },
  );
  if (has.exitCode !== 0) {
    return { running: false, sessionName: name, startedAt: null };
  }
  const ts = await execa(
    'docker',
    [
      'exec',
      '--user',
      CONTAINER_USER,
      container,
      'tmux',
      'display-message',
      '-p',
      '-t',
      name,
      '#{session_created}',
    ],
    { reject: false },
  );
  let startedAt: string | null = null;
  if (ts.exitCode === 0) {
    const secs = Number.parseInt((ts.stdout ?? '').trim(), 10);
    if (Number.isFinite(secs) && secs > 0) startedAt = new Date(secs * 1000).toISOString();
  }
  return { running: true, sessionName: name, startedAt };
}
