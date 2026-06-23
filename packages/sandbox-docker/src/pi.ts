import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { buildTmuxSessionArgs, CONTAINER_USER } from './claude.js';
import { ensureVolume, volumeExists } from './docker.js';

/**
 * pi (the Earendil "pi" coding agent, npm `@earendil-works/pi-coding-agent`)
 * support mirrors the Codex support in `codex.ts`, with two structural
 * differences:
 *
 *  - pi keeps all of its agent state under `~/.pi/agent/` (auth.json,
 *    settings.json, models.json, extensions/, ...). We mount one volume at the
 *    parent `~/.pi` and sync the host's `~/.pi/agent` into its `agent/` subdir,
 *    so pi's own cache (`~/.pi/cache`) also lands on the writable volume rather
 *    than a root-owned mountpoint parent. `PI_CODING_AGENT_DIR` pins the config
 *    dir to the mounted path regardless of `$HOME`.
 *  - pi has no interactive `auth login` subcommand. It authenticates from
 *    per-provider API-key env vars (e.g. `ANTHROPIC_API_KEY`, `ZAI_GLM_API_KEY`)
 *    or from OAuth tokens in the synced `agent/auth.json`. So there is no
 *    throwaway-login helper here — credentials are seeded from the host (synced
 *    auth.json) and forwarded env keys, exactly like the rest of pi's config.
 */
export const SHARED_PI_VOLUME = 'agentbox-pi-config';
export const DEFAULT_PI_SESSION = 'pi';
/** Volume mount point inside the box — pi's `~/.pi` parent dir. */
const CONTAINER_PI_DIR = '/home/vscode/.pi';
/** pi's agent-state dir (a subdir of the volume); the value of `PI_CODING_AGENT_DIR`. */
const CONTAINER_PI_AGENT_DIR = '/home/vscode/.pi/agent';
/** npm package that provides the `pi` binary. */
const PI_NPM_PACKAGE = '@earendil-works/pi-coding-agent';

export interface PiConfigSpec {
  /** Resolved Docker volume name mounted at /home/vscode/.pi. */
  volume: string;
}

export function resolvePiVolume(opts: { isolate: boolean; boxId: string }): PiConfigSpec {
  if (opts.isolate) {
    return { volume: `${SHARED_PI_VOLUME}-${opts.boxId}` };
  }
  return { volume: SHARED_PI_VOLUME };
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
 * Single-quote a token for /bin/sh. Conservative: anything outside the safe
 * alphabet gets wrapped. Mirrors the helper in codex.ts.
 */
function shQuote(arg: string): string {
  if (arg.length === 0) return `''`;
  if (/^[A-Za-z0-9_\-./=:@%+,]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export interface EnsurePiVolumeOptions {
  /**
   * When true and the host has a `~/.pi/agent`, rsync host -> volume on every
   * call. Additive (no `--delete`): host files win on overlap, box-only files
   * are preserved.
   */
  syncFromHost: boolean;
  /** Image used by the throwaway sync helper container (the box image). */
  image: string;
}

export interface EnsurePiVolumeResult {
  /** True only the very first time the volume is created (on this host). */
  created: boolean;
  /** True when the rsync helper ran (syncFromHost was true AND host ~/.pi/agent existed). */
  synced: boolean;
}

/**
 * Ensure the pi-config volume exists, then (when {@link
 * EnsurePiVolumeOptions.syncFromHost} is true and the host has a `~/.pi/agent`)
 * rsync host `~/.pi/agent` -> volume `agent/` via a throwaway helper container.
 * The host is treated as authoritative — same model as the codex/claude volumes.
 *
 * Sessions (`sessions/`), the rollout history (`run-history.jsonl`), the npm
 * extension cache (`npm/`, `bin/`), the live IPC socket dir (`intercom/`) and
 * editor backups (`*.bak`) are excluded: large, host-specific, or box-irrelevant.
 * `node_modules` anywhere under the tree is skipped (host-platform binaries).
 *
 * When there is nothing to sync the volume root is still `chown`ed to uid 1000
 * so the in-box `vscode` user owns `~/.pi` (and can create `~/.pi/cache`).
 */
export async function ensurePiVolume(
  spec: PiConfigSpec,
  opts: EnsurePiVolumeOptions,
): Promise<EnsurePiVolumeResult> {
  const existed = await volumeExists(spec.volume);
  await ensureVolume(spec.volume);
  const created = !existed;

  const hostPiAgent = join(homedir(), '.pi', 'agent');
  const willSync = opts.syncFromHost && (await pathExists(hostPiAgent));
  if (willSync) {
    await execa('docker', [
      'run',
      '--rm',
      '--user',
      '0',
      '-v',
      `${spec.volume}:/dst`,
      '-v',
      `${hostPiAgent}:/src:ro`,
      opts.image,
      'sh',
      '-c',
      // --copy-unsafe-links so a host extension symlinked outside ~/.pi/agent
      // still materializes; tolerate exit 23 (partial) for any link whose
      // target is not reachable in the helper (host-only paths), so one stray
      // symlink can't abort the whole seed. The chown must still run.
      'mkdir -p /dst/agent && { rsync -a --copy-unsafe-links' +
        ' --exclude=sessions --exclude=run-history.jsonl --exclude=intercom' +
        ' --exclude=npm --exclude=bin --exclude=cache --exclude=node_modules' +
        " --exclude=*.bak /src/ /dst/agent/ || [ $? -eq 23 ]; }" +
        ' && chown -R 1000:1000 /dst',
    ]);
    return { created, synced: true };
  }

  // No host ~/.pi/agent to sync — still make the (possibly freshly created,
  // root-owned) volume root writable by the in-box `vscode` user.
  await execa(
    'docker',
    [
      'run',
      '--rm',
      '--user',
      '0',
      '-v',
      `${spec.volume}:/dst`,
      opts.image,
      'sh',
      '-c',
      'mkdir -p /dst/agent && chown -R 1000:1000 /dst',
    ],
    { reject: false },
  );
  return { created, synced: false };
}

export interface PiMountResult {
  /** Docker -v spec strings to append to runBox(extraVolumes). */
  extraVolumes: string[];
  /**
   * Env vars for the container: the fixed `PI_CODING_AGENT_DIR` (pins pi's
   * config dir to the mounted path) plus any forwarded provider keys set on the
   * host.
   */
  env: Record<string, string>;
  volumeName: string;
}

// Provider API keys forwarded from the host's `process.env` into the box. pi's
// primary auth is the synced `agent/auth.json` (OAuth) plus these env keys
// (resolution order: --api-key flag > auth.json > env var > models.json). The
// GLM keys are included so `pi --model zai-glm/glm-5.2` works in the box when
// the host has the zai-glm extension + key (carried via the synced extensions/).
export const PI_FORWARDED_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
  'ZAI_API_KEY',
  'ZAI_GLM_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
] as const;

export function buildPiMounts(spec: PiConfigSpec, hostEnv: NodeJS.ProcessEnv): PiMountResult {
  // PI_CODING_AGENT_DIR is a fixed box-internal path (pins pi's agent-state
  // dir into the mounted volume). It is pi-specific, so setting it box-global
  // is safe.
  const env: Record<string, string> = {
    PI_CODING_AGENT_DIR: CONTAINER_PI_AGENT_DIR,
  };
  for (const k of PI_FORWARDED_ENV_KEYS) {
    const v = hostEnv[k];
    if (typeof v === 'string' && v.length > 0) env[k] = v;
  }
  return {
    extraVolumes: [`${spec.volume}:${CONTAINER_PI_DIR}`],
    env,
    volumeName: spec.volume,
  };
}

export class PiSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PiSessionError';
  }
}

export interface EnsurePiInstalledResult {
  /**
   * True when pi had to be installed just now — i.e. it was absent from the box
   * image. pi is not baked into the published base image, so this is the common
   * case on first use; subsequent sessions reuse the writable-layer install.
   */
  installed: boolean;
}

/**
 * Make sure the `pi` binary is on PATH inside the box. pi is installed into the
 * box's writable layer (persists across stop/start, wiped on destroy) with
 * `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` — the box
 * image already ships Node 24, so no runtime download is needed.
 * `--ignore-scripts` skips pi's postinstall (which would try to fetch a Node
 * runtime / write to ~/.local), keeping the install hermetic.
 *
 * Fast no-op (one `command -v`) when pi is already present. Throws {@link
 * PiSessionError} when pi is absent *and* the install fails.
 */
export async function ensurePiInstalled(
  container: string,
  opts: { onProgress?: (line: string) => void } = {},
): Promise<EnsurePiInstalledResult> {
  const probe = await execa(
    'docker',
    ['exec', '--user', CONTAINER_USER, container, 'sh', '-c', 'command -v pi'],
    { reject: false },
  );
  if (probe.exitCode === 0) return { installed: false };

  opts.onProgress?.('installing pi (absent from this box image)');
  const install = await execa(
    'docker',
    [
      'exec',
      '--user',
      'root',
      container,
      'bash',
      '-lc',
      `npm install -g --ignore-scripts ${PI_NPM_PACKAGE} 2>&1`,
    ],
    { reject: false },
  );
  if (install.exitCode !== 0) {
    throw new PiSessionError(
      `pi is not in this box's image and \`npm install -g ${PI_NPM_PACKAGE}\` failed ` +
        `(exit ${String(install.exitCode)}). Check the box has network access. ` +
        `Install output:\n${(install.stdout ?? '').toString().slice(-600)}`,
    );
  }
  return { installed: true };
}

export interface StartPiSessionOptions {
  container: string;
  piArgs: string[];
  sessionName?: string;
}

/**
 * Start a detached tmux session running the pi TUI inside the container.
 * Survives client disconnects; reattach via {@link buildPiAttachArgv}. The
 * shared {@link buildTmuxSessionArgs} remaps the prefix and hides the inner
 * status bar, exactly as for the claude/codex/opencode sessions.
 *
 * `PI_CODING_AGENT_DIR` is already in the container env (set at `docker run -e`
 * by {@link buildPiMounts}), so `docker exec` inherits it — only the
 * host-forwarded provider keys are re-passed here to pick up the host shell's
 * current values.
 */
export async function startPiSession(opts: StartPiSessionOptions): Promise<void> {
  const sessionName = opts.sessionName ?? DEFAULT_PI_SESSION;
  const cmd = ['pi', ...opts.piArgs].map(shQuote).join(' ');
  const term = process.env['TERM'] ?? 'xterm-256color';
  const envFlags: string[] = ['-e', `TERM=${term}`];
  for (const k of PI_FORWARDED_ENV_KEYS) {
    const v = process.env[k];
    if (typeof v === 'string' && v.length > 0) envFlags.push('-e', `${k}=${v}`);
  }
  const result = await execa(
    'docker',
    [
      'exec',
      ...envFlags,
      '--user',
      CONTAINER_USER,
      opts.container,
      'tmux',
      'new-session',
      '-d',
      '-s',
      sessionName,
      cmd,
      ...buildTmuxSessionArgs(sessionName),
    ],
    { reject: false },
  );
  if (result.exitCode === 0) return;
  const stderr = (result.stderr ?? '').toString();
  if (result.exitCode === 127 || /command not found|tmux: not found/i.test(stderr)) {
    throw new PiSessionError(
      `tmux is missing from the box image. Rebuild with: docker rmi agentbox/box:dev && retry.`,
    );
  }
  if (/pi.*not found|exec: "pi"/i.test(stderr)) {
    throw new PiSessionError(
      `pi is missing from the box image. Rebuild with: docker rmi agentbox/box:dev && retry.`,
    );
  }
  if (/duplicate session/i.test(stderr)) {
    throw new PiSessionError(
      `a tmux session "${sessionName}" already exists in ${opts.container}; use \`agentbox pi attach\` to reattach.`,
    );
  }
  throw new PiSessionError(
    `failed to start pi session in ${opts.container}: ${stderr.trim() || `exit ${String(result.exitCode)}`}`,
  );
}

/**
 * The `docker` argv that attaches an interactive terminal to a box's pi tmux
 * session. Mirrors {@link import('./codex.js').buildCodexAttachArgv}.
 */
export function buildPiAttachArgv(container: string, sessionName?: string): string[] {
  const name = sessionName ?? DEFAULT_PI_SESSION;
  const term = process.env['TERM'] ?? 'xterm-256color';
  return [
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
  ];
}

/**
 * True when the pi-config volume already holds an `agent/auth.json`. Used to
 * decide whether the box has any pi credentials seeded (env keys aside).
 */
export async function volumeHasPiAuth(volume: string, image: string): Promise<boolean> {
  const res = await execa(
    'docker',
    ['run', '--rm', '-v', `${volume}:/dst`, image, 'sh', '-c', 'test -e /dst/agent/auth.json'],
    { reject: false },
  );
  return res.exitCode === 0;
}

export interface PiSessionInfo {
  running: boolean;
  sessionName: string;
  /** ISO-8601 timestamp from tmux's `#{session_created}`, or null when not running. */
  startedAt: string | null;
}

/**
 * Best-effort: returns `{ running: false, …, startedAt: null }` for any
 * non-zero exit from `tmux has-session`. Mirrors `codexSessionInfo`.
 */
export async function piSessionInfo(
  container: string,
  sessionName?: string,
): Promise<PiSessionInfo> {
  const name = sessionName ?? DEFAULT_PI_SESSION;
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

export interface PullPiResult {
  /** Volume items copied to the host (or, in dry-run, that would be copied). */
  newItems: string[];
}

export interface PullPiOptions {
  /** Image for the throwaway helper container; use the box's image. */
  image: string;
  /** When true, compute the delta but write nothing. */
  dryRun?: boolean;
}

/** Agent-dir items `download pi` considers (volume `agent/` -> host ~/.pi/agent). */
const PI_PULL_ITEMS = ['auth.json', 'settings.json', 'models.json', 'extensions'] as const;

/**
 * Reverse of {@link ensurePiVolume}: pull box-side pi config/auth from the
 * volume `agent/` subdir back to the host's `~/.pi/agent`. Additive only — an
 * item already present on the host is never overwritten. The box need not be
 * running (we read the *volume* via a throwaway helper container).
 */
export async function pullPiConfig(spec: PiConfigSpec, opts: PullPiOptions): Promise<PullPiResult> {
  const hostPiAgent = join(homedir(), '.pi', 'agent');

  const inv = await execa(
    'docker',
    [
      'run',
      '--rm',
      '--user',
      '0',
      '-v',
      `${spec.volume}:/src:ro`,
      opts.image,
      'sh',
      '-c',
      `for f in ${PI_PULL_ITEMS.join(' ')}; do [ -e "/src/agent/$f" ] && echo "$f"; done; true`,
    ],
    { reject: false },
  );
  if (inv.exitCode !== 0) {
    throw new PiSessionError(
      `failed to read pi-config volume ${spec.volume}: ${(inv.stderr ?? '').toString().trim() || `exit ${String(inv.exitCode)}`}`,
    );
  }

  const present = new Set(
    (inv.stdout ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const newItems: string[] = [];
  for (const item of PI_PULL_ITEMS) {
    if (!present.has(item)) continue;
    if (await pathExists(join(hostPiAgent, item))) continue; // additive — never overwrite
    newItems.push(item);
  }

  if (opts.dryRun || newItems.length === 0) return { newItems };

  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const cmds = newItems.map((it) => `cp -a '/src/agent/${it}' '/dst/${it}'`);
  const apply = await execa(
    'docker',
    [
      'run',
      '--rm',
      '--user',
      '0',
      '-v',
      `${spec.volume}:/src:ro`,
      '-v',
      `${hostPiAgent}:/dst`,
      opts.image,
      'sh',
      '-c',
      `mkdir -p /dst && ${cmds.join(' && ')} && chown -R ${String(uid)}:${String(gid)} /dst`,
    ],
    { reject: false },
  );
  if (apply.exitCode !== 0) {
    throw new PiSessionError(
      `failed to copy pi config from ${spec.volume}: ${(apply.stderr ?? '').toString().trim() || `exit ${String(apply.exitCode)}`}`,
    );
  }
  return { newItems };
}
