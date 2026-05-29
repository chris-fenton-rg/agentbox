/**
 * Inject the per-agent "skip permission prompts" flag into a fresh agent
 * launch, driven by `claude.dangerouslySkipPermissions` /
 * `codex.dangerouslySkipPermissions`. A box is an isolated sandbox, so
 * auto-accepting tool use removes friction the box already makes safe — hence
 * the config defaults to on (see BUILT_IN_DEFAULTS in @agentbox/config).
 *
 * Applied at the command layer (where the effective config is resolved) to the
 * arg array that flows to BOTH the docker session start (`startXxxSession`) and
 * the cloud attach (`extraArgs` -> `buildCloudAttachInnerCommand`), so one
 * call covers every provider.
 *
 * If the user already passed a flag that controls the same surface (e.g.
 * `claude -- --permission-mode plan`, `codex -- -a never`), we leave their args
 * untouched — an explicit choice always wins.
 */
import type { EffectiveConfig } from '@agentbox/config';

/** Claude's full permission-bypass flag (auto-accept all tool use). */
export const CLAUDE_SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions';
/**
 * Codex's only "never prompt" flag. It disables codex's own internal sandbox in
 * addition to approval prompts — redundant-but-safe here since the AgentBox box
 * is already the sandbox.
 */
export const CODEX_SKIP_PERMISSIONS_FLAG = '--dangerously-bypass-approvals-and-sandbox';

// User args that already govern claude's permission behavior — presence means
// "the user decided", so we don't inject.
const CLAUDE_CONFLICTING = new Set([CLAUDE_SKIP_PERMISSIONS_FLAG, '--permission-mode']);
// Likewise for codex's approval / sandbox surface.
const CODEX_CONFLICTING = new Set([
  CODEX_SKIP_PERMISSIONS_FLAG,
  '--yolo',
  '--full-auto',
  '-a',
  '--ask-for-approval',
  '-s',
  '--sandbox',
]);

function inject(args: string[], flag: string, conflicting: Set<string>): string[] {
  // Match both `--permission-mode plan` and `--permission-mode=plan` — the flag
  // name is everything before the first `=` when the user uses inline syntax.
  const hasConflict = args.some((a) => {
    const eq = a.indexOf('=');
    return conflicting.has(eq === -1 ? a : a.slice(0, eq));
  });
  if (hasConflict) return args;
  return [flag, ...args];
}

/** Prepend claude's skip-permissions flag when the config enables it. */
export function applyClaudeSkipPermissions(args: string[], cfg: EffectiveConfig): string[] {
  if (!cfg.claude.dangerouslySkipPermissions) return args;
  return inject(args, CLAUDE_SKIP_PERMISSIONS_FLAG, CLAUDE_CONFLICTING);
}

/** Prepend codex's bypass-approvals flag when the config enables it. */
export function applyCodexSkipPermissions(args: string[], cfg: EffectiveConfig): string[] {
  if (!cfg.codex.dangerouslySkipPermissions) return args;
  return inject(args, CODEX_SKIP_PERMISSIONS_FLAG, CODEX_CONFLICTING);
}
