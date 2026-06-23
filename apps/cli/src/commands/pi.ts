import { intro, log, outro, spinner } from '../lib/prompt.js';
import {
  findProjectRoot,
  loadEffectiveConfig,
  resolveDefaultCheckpoint,
  type AttachOpenIn,
  type UserConfig,
} from '@agentbox/config';
import {
  buildPiAttachArgv,
  createBox,
  DEFAULT_RELAY_PORT,
  ensurePiInstalled,
  ensurePiVolume,
  formatDetachNotice,
  inspectBox,
  PiSessionError,
  piSessionInfo,
  startBox,
  startPiSession,
  unpauseBox,
  type BoxRecord,
} from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { reattachRef, resolveBoxOrExit, resolveBoxOrShift } from '../box-ref.js';
import { assertAgentCredsAvailable, MissingAgentCredsError } from '../lib/queue/assert-creds.js';
import { parseMaxOption } from '../lib/queue/parse-max-option.js';
import { submitQueueJob } from '../lib/queue/submit.js';
import { captureOpenTerminalContext } from '../terminal/queue-open.js';
import { hostAwareOpenIn } from '../terminal/host.js';
import { maybeResyncWorkspace } from '../lib/resync-start.js';
import { buildResyncWarning } from '../lib/resync-warning.js';
import {
  ATTACH_IN_HELP,
  INLINE_HELP,
  NO_ATTACH_HELP,
  resolveAttachInOption,
} from './_attach-in.js';
import { runCarryGate, runQueuedCarryGate } from '../lib/carry-gate.js';
import { FromBranchError, UseBranchError, resolveBranchSelection } from '../lib/from-branch.js';
import { prepareTeleport, TeleportError } from '../session-teleport/index.js';
import { makeProgressReporter } from '../lib/progress.js';
import { printLaunchRecap } from '../lib/launch-recap.js';
import { openCommandLog } from '../lib/log-file.js';
import { resolveLimits } from '../limits.js';
import { maybePromptPortless } from '../portless-prompt.js';
import { detectEngine } from '@agentbox/sandbox-docker';
import { clampSpinnerLine } from '../spinner-line.js';
import { runWrappedAttach } from '../wrapped-pty/index.js';
import { handleLifecycleError } from './_errors.js';

function pickPiCreateOpts(opts: PiCreateOptions): import('@agentbox/relay').QueueJobCreateOpts {
  return {
    workspace: opts.workspace,
    name: opts.name,
    hostSnapshot: opts.hostSnapshot,
    snapshot: opts.snapshot,
    image: opts.image,
    withPlaywright: opts.withPlaywright,
    withEnv: opts.withEnv,
    vnc: opts.vnc,
    resync: opts.resync,
    sharedDockerCache: opts.sharedDockerCache,
    portless: opts.portless,
    sessionName: opts.sessionName,
    memory: opts.memory,
    cpus: opts.cpus,
    pidsLimit: opts.pidsLimit,
    disk: opts.disk,
  };
}

/** Host-side URL for the relay (loopback for the wrapper's SSE subscription). */
const RELAY_HOST_URL = `http://127.0.0.1:${String(DEFAULT_RELAY_PORT)}`;

/** Reject cloud providers — pi is docker-only in v1 (cloud base snapshots don't ship pi yet). */
function assertDockerProvider(providerName: string): void {
  if (providerName !== 'docker') {
    throw new PiSessionError(
      `agentbox pi is currently docker-only; the '${providerName}' provider is not yet supported ` +
        `(pi is not baked into the cloud base snapshots — tracked as a follow-up). ` +
        `Run \`agentbox pi\` without --provider, or use claude/codex/opencode on cloud providers.`,
    );
  }
}

/**
 * Attach to a box's pi tmux session through the wrapped-pty footer (same
 * channel `agentbox claude`/`codex`/`opencode` use for host-action prompts),
 * then exit with the inner pty's code.
 */
export async function attachPiWrapped(
  box: { id: string; name: string; container: string; projectIndex?: number },
  sessionName: string | undefined,
  reattach: string,
  onError?: (msg: string) => void,
  openIn?: AttachOpenIn,
): Promise<never> {
  const code = await runWrappedAttach({
    container: box.container,
    dockerArgv: buildPiAttachArgv(box.container, sessionName),
    relayBaseUrl: RELAY_HOST_URL,
    boxId: box.id,
    boxName: box.name,
    projectIndex: box.projectIndex,
    mode: 'pi',
    detachable: true,
    detachNotice: formatDetachNotice(reattach, 'pi'),
    onError,
    openIn,
  });
  process.exit(code);
}

interface PiCreateOptions {
  workspace: string;
  name?: string;
  hostSnapshot?: boolean;
  snapshot?: string;
  image?: string;
  yes?: boolean;
  isolatePiConfig?: boolean;
  withPlaywright?: boolean;
  withEnv?: boolean;
  carryYes?: boolean;
  carry?: 'skip' | 'ask';
  vnc?: boolean;
  resync?: boolean;
  sharedDockerCache?: boolean;
  portless?: boolean;
  sessionName?: string;
  memory?: string;
  cpus?: string;
  pidsLimit?: string;
  disk?: string;
  provider?: string;
  fromBranch?: string;
  useBranch?: string;
  verbose?: boolean;
  attachIn?: string;
  inline?: boolean;
  attach?: boolean;
  initialPrompt?: string;
  maxRunning?: string;
  maxWorking?: string;
  continue?: boolean;
  resume?: string;
}

function buildPiCliOverrides(opts: PiCreateOptions): Partial<UserConfig> {
  const box: NonNullable<UserConfig['box']> = {};
  if (opts.hostSnapshot !== undefined) box.hostSnapshot = opts.hostSnapshot;
  if (opts.image !== undefined) box.image = opts.image;
  if (opts.withPlaywright === true) box.withPlaywright = true;
  if (opts.withEnv === true) box.withEnv = true;
  if (opts.vnc === false) box.vnc = false;
  if (opts.isolatePiConfig === true) box.isolatePiConfig = true;
  if (opts.sharedDockerCache === true) box.dockerCacheShared = true;
  const pi: NonNullable<UserConfig['pi']> = {};
  if (opts.sessionName !== undefined) pi.sessionName = opts.sessionName;
  const out: Partial<UserConfig> = {};
  if (Object.keys(box).length > 0) out.box = box;
  if (Object.keys(pi).length > 0) out.pi = pi;
  if (opts.portless !== undefined) out.portless = { enabled: opts.portless };
  const attachIn = resolveAttachInOption(opts);
  if (attachIn !== undefined) out.attach = { openIn: attachIn };
  return out;
}

export const piCommand = new Command('pi')
  .description('Create a sandboxed box and launch the pi coding agent in a detachable tmux session')
  // Mirror create's surface so users can swap the verb without re-learning flags.
  .option('-w, --workspace <path>', 'host workspace to mount', process.cwd())
  .option('-n, --name <name>', 'friendly box name (default: <workspace-basename>-<id>)')
  .option('--host-snapshot', 'APFS-clone the host workspace into a per-box scratch dir before seeding /workspace (stabilizes the tar-pipe source)')
  .option('--no-host-snapshot', 'tar-pipe directly from the live host workspace at create time')
  .option(
    '--snapshot <ref>',
    'start from a project checkpoint (see `agentbox checkpoint`); overrides box.defaultCheckpoint',
  )
  .option('--image <ref>', 'override the box image')
  .option('-y, --yes', 'skip prompts, accept defaults')
  .option(
    '--carry-yes',
    "auto-approve agentbox.yaml's `carry:` block (also AGENTBOX_CARRY_YES=1). Required for non-TTY use of `-y` when carry: is non-empty.",
  )
  .option(
    '--carry <mode>',
    "control the carry: block; 'skip' disables it for this box (also AGENTBOX_CARRY=skip). Default: 'ask' (prompt).",
    'ask',
  )
  .option(
    '--isolate-pi-config',
    'use a per-box pi config volume instead of the shared agentbox-pi-config',
  )
  .option('--with-playwright', 'also install @playwright/cli@latest globally inside the box')
  .option(
    '--with-env',
    'copy host env/config files (.env*, secrets.toml, agentbox.yaml, ...) into /workspace at create time (gitignore-bypassing)',
  )
  .option('--no-vnc', 'disable the per-box Xvnc + noVNC web client (on by default)')
  .option(
    '--no-resync',
    "do not sync the box with the host on start (default: merge the host's current branch + overlay its uncommitted/untracked changes, keeping the box's version on conflict)",
  )
  .option(
    '--shared-docker-cache',
    "use the shared 'agentbox-docker-cache' volume for in-box docker images (preserved on destroy; only one box can run at a time when set)",
  )
  .option(
    '--portless',
    'map the box web app to https://<name>.localhost via the Portless proxy (Docker Desktop)',
  )
  .option('--no-portless', 'do not register a Portless alias for this box')
  .option('--session-name <name>', 'tmux session name (default from config; built-in: pi)')
  .option('--memory <size>', 'memory ceiling (e.g. 512m, 2g); unset = unlimited')
  .option('--cpus <n>', 'CPU count cap (fractional ok, e.g. 1.5); unset = unlimited')
  .option('--pids-limit <n>', 'max process count (PIDs cgroup); unset = unlimited')
  .option('--disk <size>', 'best-effort writable-layer size (e.g. 10g); no-op on overlay2/macOS')
  .option('--provider <name>', "sandbox backend (pi is docker-only in v1; default 'docker')")
  .option(
    '--from-branch <ref>',
    "base the box's per-box branch on this ref (branch / tag / SHA) instead of HEAD. Branch/tag names are fetched from origin first.",
  )
  .option(
    '-b, --use-branch <name>',
    "reuse an existing branch directly instead of forking agentbox/<box-name>. Commits/pushes flow straight to it. Docker fails if the host already has it checked out. Mutually exclusive with --from-branch.",
  )
  .option(
    '-v, --verbose',
    'bypass the spinner and stream raw provider output to stderr. The same content always lands in ~/.agentbox/logs/pi.log.',
  )
  .option('--attach-in <mode>', ATTACH_IN_HELP)
  .option('--inline', INLINE_HELP)
  .option('-d, --no-attach', NO_ATTACH_HELP)
  .option(
    '-i, --initial-prompt <text>',
    'seed the pi session with this initial user turn and run in background (no attach). Jobs go through the host-wide queue (queue.maxConcurrent).',
  )
  .option(
    '--max-running <n>',
    'per-invocation override of queue.maxConcurrent; only honored when `-i` is set',
  )
  .option(
    '--max-working <n>',
    'per-invocation override of queue.maxWorking; only honored when `-i` is set',
  )
  .option(
    '-c, --continue',
    'session teleport (not yet supported for pi in v1; emits a friendly error)',
  )
  .option(
    '--resume <id>',
    'session teleport (not yet supported for pi in v1; emits a friendly error)',
  )
  .argument(
    '[pi-args...]',
    "extra args passed to pi inside the box; place after `--`, e.g. `agentbox pi -- --model zai-glm/glm-5.2`",
  )
  .action(async (piArgs: string[], opts: PiCreateOptions) => {
    const cmdLog = openCommandLog('pi');
    intro('Starting pi in a box...');

    // pi session teleport is not yet supported (v1 stub). Detect resume flags
    // early and bail with a clear message before any box work happens.
    if (opts.continue === true || opts.resume) {
      try {
        await prepareTeleport({
          agent: 'pi',
          hostCwd: opts.workspace,
          mode:
            opts.continue === true ? { kind: 'continue' } : { kind: 'resume', id: opts.resume! },
        });
      } catch (err) {
        if (err instanceof TeleportError) {
          log.error(err.message);
          cmdLog.close();
          process.exit(2);
        }
        throw err;
      }
    }

    const cfg = await loadEffectiveConfig(opts.workspace, {
      cliOverrides: buildPiCliOverrides(opts),
    });
    const projectRoot = (await findProjectRoot(opts.workspace)).root;
    const providerName = opts.provider ?? cfg.effective.box.provider ?? 'docker';
    try {
      assertDockerProvider(providerName);
    } catch (err) {
      if (err instanceof PiSessionError) {
        log.error(err.message);
        cmdLog.close();
        process.exit(2);
      }
      throw err;
    }
    const providerDefault = resolveDefaultCheckpoint(cfg.effective, providerName);
    const checkpointRef =
      opts.snapshot && opts.snapshot.length > 0
        ? opts.snapshot
        : providerDefault.length > 0
          ? providerDefault
          : undefined;

    if (opts.initialPrompt && opts.initialPrompt.length > 0) {
      try {
        await assertAgentCredsAvailable({ agent: 'pi', image: cfg.effective.box.image });
      } catch (err) {
        if (err instanceof MissingAgentCredsError) {
          log.error(err.message);
          cmdLog.close();
          process.exit(2);
        }
        throw err;
      }
      const maxRunningOverride = parseMaxOption('--max-running', opts.maxRunning);
      const maxWorkingOverride = parseMaxOption('--max-working', opts.maxWorking);
      const carryForQueue = await runQueuedCarryGate({
        projectRoot,
        opts,
        onLog: (line) => cmdLog.write(line),
        onClose: () => cmdLog.close(),
      });
      const result = await submitQueueJob({
        agent: 'pi',
        boxName: opts.name ?? '',
        providerName,
        prompt: opts.initialPrompt,
        agentArgs: piArgs,
        createOpts: { ...pickPiCreateOpts(opts), carry: carryForQueue },
        maxRunningOverride,
        maxWorkingOverride,
        openTerminal: captureOpenTerminalContext(cfg.effective.queue.openIn),
      });
      outro(
        `job ${result.job.id} queued (${String(result.runningCount)}/${String(result.maxConcurrent)} running); log: ${result.job.logPath}`,
      );
      cmdLog.close();
      return;
    }

    // Carry gate (agentbox.yaml's `carry:` block): resolve + ask before any
    // box work. Cancel aborts; skip proceeds with no carry payload.
    let carryEntries: import('@agentbox/core').ResolvedCarryEntry[] = [];
    try {
      const gate = await runCarryGate({
        projectRoot,
        yes: !!opts.yes,
        carryYesFlag: opts.carryYes ? true : undefined,
        carrySkipFlag: opts.carry === 'skip' ? true : undefined,
        onLog: (line) => cmdLog.write(line),
      });
      if (gate.decision === 'cancel') {
        log.warn('carry: cancelled — not creating the box');
        cmdLog.close();
        process.exit(0);
      }
      if (gate.decision === 'approve') carryEntries = gate.entries;
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      cmdLog.close();
      process.exit(1);
    }

    let fromBranch: string | undefined;
    let useBranch: string | undefined;
    try {
      ({ fromBranch, useBranch } = await resolveBranchSelection({
        useBranch: opts.useBranch,
        fromBranch: opts.fromBranch,
        repo: opts.workspace,
        providerName,
        cloudUseCurrentBranch: cfg.effective.cloud.useCurrentBranch,
        log: (m) => cmdLog.write(m),
      }));
    } catch (err) {
      if (err instanceof FromBranchError || err instanceof UseBranchError) {
        log.error(err.message);
        cmdLog.close();
        process.exit(2);
      }
      throw err;
    }

    // First-run Portless opt-in (Docker Desktop only).
    const portlessEnabled = await maybePromptPortless({
      engine: await detectEngine(),
      enabled: cfg.effective.portless.enabled,
      yes: !!opts.yes,
      cwd: opts.workspace,
    });

    // host-snapshot default off: explicit flag/config wins.
    const useSnapshot =
      opts.hostSnapshot === false
        ? false
        : opts.hostSnapshot === true
          ? true
          : (cfg.effective.box.hostSnapshot ?? false);
    const sessionName = cfg.effective.pi.sessionName;

    const s = makeProgressReporter(opts.verbose === true);
    s.start('creating box');
    let containerName = '';
    try {
      const withPlaywright =
        cfg.effective.box.withPlaywright || cfg.effective.browser.default !== 'agent-browser';
      const result = await createBox({
        workspacePath: opts.workspace,
        name: opts.name,
        useSnapshot,
        checkpointRef,
        fromBranch,
        useBranch,
        resyncOnStart: opts.resync,
        image: cfg.effective.box.image,
        piConfig: { isolate: cfg.effective.box.isolatePiConfig },
        withPlaywright,
        withEnv: cfg.effective.box.withEnv,
        carry: carryEntries,
        vnc: { enabled: cfg.effective.box.vnc },
        docker: { sharedCache: cfg.effective.box.dockerCacheShared },
        portless: portlessEnabled,
        portlessStateDir: cfg.effective.portless.stateDir || undefined,
        limits: resolveLimits(cfg.effective.box, opts),
        projectRoot,
        onLog: (line) => {
          s.message(line);
          cmdLog.write(line);
        },
      });
      containerName = result.record.container;

      // pi is not baked into the base image; install it into the box's
      // writable layer (fast no-op once present).
      s.message('checking pi');
      cmdLog.write('checking pi');
      await ensurePiInstalled(result.record.container, {
        onProgress: (line) => {
          s.message(line);
          cmdLog.write(line);
        },
      });

      s.message('starting pi session');
      await startPiSession({
        container: result.record.container,
        piArgs,
        sessionName,
      });
      const createResyncWarning = result.resync ? buildResyncWarning(result.resync) : null;

      const nSuffix =
        typeof result.record.projectIndex === 'number'
          ? `  ·  n ${String(result.record.projectIndex)}`
          : '';
      s.stop(`box ready${nSuffix}`);
      if (createResyncWarning) log.warn(createResyncWarning);

      await printLaunchRecap({
        record: result.record,
        mode: 'pi',
        reattach: reattachRef(result.record),
        workspacePath: opts.workspace,
        fromBranch,
        useBranch,
        checkpointRef,
        attaching: opts.attach !== false,
      });
      if (opts.attach === false) {
        return;
      }
      await attachPiWrapped(
        result.record,
        sessionName,
        reattachRef(result.record),
        (m) => cmdLog.write(m),
        hostAwareOpenIn(cfg),
      );
    } catch (err) {
      s.stop('failed');
      cmdLog.write(`FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      if (err instanceof PiSessionError) {
        log.error(err.message);
        if (containerName) {
          log.info(`The box ${containerName} is still running. Destroy it with:`);
          log.info(`  agentbox destroy ${containerName} -y`);
        }
        cmdLog.close();
        process.exit(1);
      }
      handleLifecycleError(err);
    } finally {
      cmdLog.close();
    }
  });

interface PiStartOptions {
  sessionName?: string;
  resync?: boolean;
  syncConfig?: boolean;
  attachIn?: string;
  inline?: boolean;
  attach?: boolean;
  continue?: boolean;
  resume?: string;
}

// Shared by `pi start` and `pi attach`: if a session is already running, just
// attach; otherwise auto-unpause/start the box, (optionally) resync the pi
// config, launch pi, then attach.
async function startOrAttachPi(
  box: BoxRecord,
  piArgs: string[],
  opts: PiStartOptions,
): Promise<void> {
  const attachIn = resolveAttachInOption(opts);
  const cliOverrides: Partial<UserConfig> = {};
  if (opts.sessionName) cliOverrides.pi = { sessionName: opts.sessionName };
  if (attachIn !== undefined) cliOverrides.attach = { openIn: attachIn };
  if (opts.resync !== undefined) cliOverrides.box = { resyncOnStart: opts.resync };
  const cfg = await loadEffectiveConfig(box.workspacePath, { cliOverrides });
  const sessionName = cfg.effective.pi.sessionName;
  const openIn = hostAwareOpenIn(cfg);
  const wantAttach = opts.attach !== false;

  const insp = await inspectBox(box.id);
  if (insp.state === 'missing') {
    throw new Error(`box ${box.name} has no container; was it destroyed?`);
  }

  // If a tmux session already exists, just attach — no resync, ignore any
  // post-`--` args (they only apply to a fresh pi).
  const existing = await piSessionInfo(box.container, sessionName);
  if (existing.running) {
    if (!wantAttach) {
      outro(
        `session "${sessionName}" already running — attach with: agentbox pi attach ${reattachRef(box)}`,
      );
      return;
    }
    outro(`session "${sessionName}" already running — attaching (Control+a d to detach)`);
    await attachPiWrapped(box, sessionName, reattachRef(box), undefined, openIn);
    return;
  }

  const s = spinner();
  s.start('preparing box');

  // Auto-unpause/start. `startBox` relaunches ctl/vnc/dockerd.
  const wasDown = insp.state === 'paused' || insp.state === 'stopped';
  if (insp.state === 'paused') {
    s.message('unpausing box');
    await unpauseBox(box.id);
  } else if (insp.state === 'stopped') {
    s.message('starting box');
    await startBox(box.id);
  }

  // Resync the workspace with the host (docker-only, down→up transition only).
  const resyncWarning = await maybeResyncWorkspace({
    box,
    enabled: cfg.effective.box.resyncOnStart && wasDown,
    projectRoot: cfg.projectRoot,
    spinner: s,
  });

  // Re-sync the host's pi config/auth into the box volume (default; opt out
  // with --no-sync-config). Skipped for `pi attach`, and for boxes with no pi
  // volume mounted.
  const syncConfig = opts.syncConfig !== false;
  if (syncConfig && box.piConfigVolume) {
    s.message('syncing pi config into box volume');
    await ensurePiVolume({ volume: box.piConfigVolume }, { syncFromHost: true, image: box.image });
  }

  // Install pi if the box image lacks it.
  s.message('checking pi');
  await ensurePiInstalled(box.container, {
    onProgress: (line) => s.message(clampSpinnerLine(line)),
  });

  s.message('starting pi session');
  await startPiSession({ container: box.container, piArgs, sessionName });

  s.stop(`box ${box.container} ready`);
  if (resyncWarning) log.warn(resyncWarning);

  if (!wantAttach) {
    outro(`session "${sessionName}" started — attach with: agentbox pi attach ${reattachRef(box)}`);
    return;
  }
  outro('attaching — Control+a d to detach, leaves pi running');
  await attachPiWrapped(box, sessionName, reattachRef(box), undefined, openIn);
}

const piAttachCommand = new Command('attach')
  .description(
    'Attach to a pi tmux session in a box, starting one if none is running (auto-unpause/start; never re-syncs config — use `pi start` for that)',
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('--session-name <name>', 'tmux session name (default from config; built-in: pi)')
  .option('--attach-in <mode>', ATTACH_IN_HELP)
  .option('-i, --inline', INLINE_HELP)
  .action(async function (this: Command, idOrName: string | undefined) {
    const opts = this.optsWithGlobals() as PiStartOptions;
    intro('Attaching to pi session...');
    try {
      const box = await resolveBoxOrExit(idOrName);
      if ((box.provider ?? 'docker') !== 'docker') {
        log.error('agentbox pi is docker-only in v1; this box is on a cloud provider.');
        process.exit(2);
      }
      await startOrAttachPi(box, [], { ...opts, syncConfig: false });
    } catch (err) {
      if (err instanceof PiSessionError) {
        log.error(err.message);
        process.exit(1);
      }
      handleLifecycleError(err);
    }
  });

const piStartCommand = new Command('start')
  .description(
    'Start a pi tmux session in an already-existing box (auto-unpause/start). If a session is already running, just attach.',
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('--session-name <name>', 'tmux session name (default from config; built-in: pi)')
  .option(
    '--no-sync-config',
    "skip rsyncing the host's pi config into the box's volume before starting (faster; use existing in-box state)",
  )
  .option('--attach-in <mode>', ATTACH_IN_HELP)
  .option('-i, --inline', INLINE_HELP)
  .option('-d, --no-attach', NO_ATTACH_HELP)
  .option(
    '-c, --continue',
    'session teleport (not yet supported for pi in v1; emits a friendly error)',
  )
  .option(
    '--resume <id>',
    'session teleport (not yet supported for pi in v1; emits a friendly error)',
  )
  .argument(
    '[pi-args...]',
    "extra args passed to pi when starting a new session; ignored if a session is already running. Place after `--`, e.g. `agentbox pi start 1 -- --model zai-glm/glm-5.2`",
  )
  .action(async function (this: Command, idOrName: string | undefined, piArgs: string[]) {
    const opts = this.optsWithGlobals() as PiStartOptions;
    intro('Starting pi in a box...');
    try {
      // Two positionals make commander bind the first post-`--` token to
      // `[box]`; resolveBoxOrShift detects that and auto-picks the box.
      const { box, shifted } = await resolveBoxOrShift(idOrName);
      const effectivePiArgs = shifted && idOrName ? [idOrName, ...piArgs] : piArgs;
      if (opts.continue === true || opts.resume) {
        try {
          await prepareTeleport({
            agent: 'pi',
            hostCwd: box.workspacePath,
            mode:
              opts.continue === true ? { kind: 'continue' } : { kind: 'resume', id: opts.resume! },
          });
        } catch (err) {
          if (err instanceof TeleportError) {
            log.error(err.message);
            process.exit(2);
          }
          throw err;
        }
      }
      if ((box.provider ?? 'docker') !== 'docker') {
        log.error('agentbox pi is docker-only in v1; this box is on a cloud provider.');
        process.exit(2);
      }
      await startOrAttachPi(box, effectivePiArgs, opts);
    } catch (err) {
      if (err instanceof PiSessionError) {
        log.error(err.message);
        process.exit(1);
      }
      handleLifecycleError(err);
    }
  });

piCommand.addCommand(piAttachCommand);
piCommand.addCommand(piStartCommand);
