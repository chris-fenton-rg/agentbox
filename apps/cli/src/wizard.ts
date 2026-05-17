import { confirm, isCancel, log } from '@clack/prompts';
import { findProjectRoot } from '@agentbox/config';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * In-box absolute path to the setup guide markdown (baked into the box image
 * by Dockerfile.box). Stable so the wizard's initial-prompt can reference it.
 */
export const IN_BOX_SETUP_GUIDE_PATH = '/usr/local/share/agentbox/setup-guide.md';

const HOST_SKILLS_DIR = join(homedir(), '.claude', 'skills', 'agentbox-setup');
const HOST_SKILL_FILE = join(HOST_SKILLS_DIR, 'SKILL.md');

// `share/agentbox-setup/SKILL.md` sits next to `dist/` after tsup build and at
// the package root after npm publish; both resolve via `../share/...` relative
// to dist/index.js.
function bundledSkillPath(): string {
  return fileURLToPath(new URL('../share/agentbox-setup/SKILL.md', import.meta.url));
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const st = await stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * Idempotently install the host-side `/agentbox-setup` claude skill so the
 * user can re-invoke it later from any claude session. Never overwrites: a
 * pre-existing SKILL.md is assumed to be intentional (user customized it).
 * The existing `ensureClaudeVolume` rsync (packages/sandbox-docker/src/claude.ts)
 * propagates ~/.claude/skills/ into every box automatically.
 *
 * `opts.targetFile` and `opts.sourceFile` exist for tests.
 */
export async function installAgentboxSetupSkill(
  opts: { targetFile?: string; sourceFile?: string } = {},
): Promise<{ installed: boolean; targetFile: string }> {
  const targetFile = opts.targetFile ?? HOST_SKILL_FILE;
  const targetDir = join(targetFile, '..');
  if (await fileExists(targetFile)) return { installed: false, targetFile };
  const src = opts.sourceFile ?? bundledSkillPath();
  if (!(await fileExists(src))) {
    // Bundled asset missing — happens if the user built without copying share/.
    // Don't crash the wizard, just skip the install silently.
    return { installed: false, targetFile };
  }
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  await copyFile(src, targetFile);
  return { installed: true, targetFile };
}

export function buildSetupInitialPrompt(workspace: string): string {
  const name = basename(workspace);
  return (
    `The user just opened a new agentbox sandbox for "${name}" but the workspace has no agentbox.yaml yet. ` +
    `Please run the /agentbox-setup skill (or read ${IN_BOX_SETUP_GUIDE_PATH} if the skill is not loaded), ` +
    `then explore /workspace and propose an agentbox.yaml. Save the file to /workspace/agentbox.yaml. ` +
    `Then run \`agentbox-ctl reload\` from inside the box so the already-running supervisor applies the new config ` +
    `and immediately runs the declared tasks and autostarts the services (no box restart needed). ` +
    `When done, summarise what services and tasks you declared, and remind the user how to land the file on the host ` +
    `(commit through the bind-mounted .git, or "agentbox pull env" on the host).`
  );
}

export type WizardAction = 'proceed' | 'switch-to-claude' | 'launch-with-prompt';

export interface WizardOutcome {
  action: WizardAction;
  initialPrompt?: string;
}

interface WizardArgs {
  workspace: string;
  yes: boolean;
  command: 'create' | 'claude';
  /**
   * Resolved checkpoint ref this box will start from (explicit `--snapshot`
   * or the project's `box.defaultCheckpoint`), if any. When set, the project
   * is already configured: the checkpoint carries the warm state *and* the
   * agentbox.yaml that was present when it was captured, so we skip the
   * "generate one?" prompt entirely.
   */
  checkpointRef?: string;
}

/**
 * Sentinel env var set by `agentbox create` when it re-dispatches to
 * `agentbox claude`. It tells the inner wizard the user has already
 * confirmed: skip the prompts and slot the initial setup prompt for claude.
 */
export const WIZARD_AUTOLAUNCH_ENV = 'AGENTBOX_WIZARD_AUTOLAUNCH';

export async function maybeRunSetupWizard(args: WizardArgs): Promise<WizardOutcome> {
  // Re-entry from agentbox create → claude: outer pass already prompted +
  // installed the skill; just inject the initial prompt for claude.
  if (process.env[WIZARD_AUTOLAUNCH_ENV] === '1') {
    if (args.command !== 'claude') return { action: 'proceed' };
    if (args.checkpointRef) return { action: 'proceed' };
    const proj = await findProjectRoot(args.workspace);
    if (proj.hasAgentboxYaml) return { action: 'proceed' };
    return {
      action: 'launch-with-prompt',
      initialPrompt: buildSetupInitialPrompt(proj.root),
    };
  }

  if (args.yes) return { action: 'proceed' };
  if (!process.stdin.isTTY) return { action: 'proceed' };

  const proj = await findProjectRoot(args.workspace);
  if (proj.hasAgentboxYaml) return { action: 'proceed' };

  // A configured default checkpoint means the project is already set up — the
  // checkpoint carries node_modules/env *and* the agentbox.yaml from when it
  // was captured. Don't nag to regenerate one.
  if (args.checkpointRef) {
    log.info(`starting from checkpoint "${args.checkpointRef}"; skipping agentbox.yaml setup`);
    return { action: 'proceed' };
  }

  const go = await confirm({
    message: 'Set up a new Agentbox environment?',
    initialValue: true,
  });
  if (isCancel(go) || !go) return { action: 'proceed' };

  // Install the skill once so the user can re-invoke /agentbox-setup later.
  // Silent on subsequent runs.
  try {
    const r = await installAgentboxSetupSkill();
    if (r.installed) {
      log.success(`installed /agentbox-setup skill at ${r.targetFile}`);
    }
  } catch (err) {
    log.warn(`could not install /agentbox-setup skill: ${(err as Error).message}`);
  }

  // For `agentbox create`, the only sensible yes-path is to hand off to
  // `agentbox claude` (that's where the agent runs). No second prompt — the
  // first confirm already captured the user's intent.
  if (args.command === 'create') return { action: 'switch-to-claude' };

  return {
    action: 'launch-with-prompt',
    initialPrompt: buildSetupInitialPrompt(proj.root),
  };
}

/**
 * Map the create command's parsed options to an argv that can be re-dispatched
 * through `claudeCommand.parseAsync(['node', 'agentbox', 'claude', ...args])`.
 * `--yes` is intentionally NOT passed through here: the wizard already prompted
 * the user, and forwarding `--yes` would suppress claude's own setup-token
 * prompt that the user typically wants on first run.
 */
export interface CreatePassthroughOptions {
  workspace?: string;
  name?: string;
  hostSnapshot?: boolean;
  snapshot?: string;
  image?: string;
  withPlaywright?: boolean;
  vnc?: boolean;
  sharedDockerCache?: boolean;
}

export function passthroughFlags(opts: CreatePassthroughOptions): string[] {
  const out: string[] = [];
  if (opts.workspace) out.push('--workspace', opts.workspace);
  if (opts.name) out.push('--name', opts.name);
  if (opts.hostSnapshot === true) out.push('--host-snapshot');
  if (opts.hostSnapshot === false) out.push('--no-host-snapshot');
  if (opts.snapshot) out.push('--snapshot', opts.snapshot);
  if (opts.image) out.push('--image', opts.image);
  if (opts.withPlaywright === true) out.push('--with-playwright');
  if (opts.vnc === false) out.push('--no-vnc');
  if (opts.sharedDockerCache === true) out.push('--shared-docker-cache');
  return out;
}

// Exposed for tests.
export const _internals = { HOST_SKILL_FILE, HOST_SKILLS_DIR, bundledSkillPath };
