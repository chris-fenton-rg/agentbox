import { log } from '@clack/prompts';
import { DEFAULT_RELAY_PORT } from '@agentbox/sandbox-docker';
import type { BoxRecord } from '@agentbox/core';
import { providerForBox } from '../provider/registry.js';
import { runWrappedAttach } from '../wrapped-pty/index.js';

const RELAY_HOST_URL = `http://127.0.0.1:${String(DEFAULT_RELAY_PORT)}`;

/**
 * Attach to (or create) a tmux session inside a cloud sandbox over SSH and
 * run an agent CLI inside it. Shared between `agentbox claude`/`codex`/
 * `opencode` so the SSH + tmux mechanics live in one place.
 *
 * The inner command tmux runs is `bash -lc 'exec <binary>'`:
 *   - login shell so `/home/vscode/.local/bin` is on PATH and `/etc/profile.d/
 *     agentbox.sh` exports `AGENTBOX_BOX_*` env;
 *   - `exec` so the agent gets PID 2 (Ctrl-c in the agent kills the session
 *     cleanly rather than dropping to bash).
 *
 * v1 limitation: extra `<agent>-args` after `--` are dropped with a warning.
 * Quoting them through 3 nested shell layers (SSH → tmux → bash) is fiddly
 * enough to defer to Phase 6; users can pass them inside the agent's TUI.
 */
export interface CloudAgentAttachArgs {
  box: BoxRecord;
  /** In-sandbox binary path or name (`claude`, `codex`, `opencode`). */
  binary: string;
  /** Tmux session name (e.g. `claude`). */
  sessionName: string;
  /** Mode label for the wrapper's footer. */
  mode: 'claude' | 'codex' | 'opencode';
  /** Extra args the user typed after `--`; warned and ignored in v1. */
  extraArgs?: string[];
}

export async function cloudAgentAttach(args: CloudAgentAttachArgs): Promise<void> {
  if (args.extraArgs && args.extraArgs.length > 0) {
    log.warn(
      `cloud ${args.mode}: extra args are not forwarded yet — start the session here and pass them inside, or attach to a plain shell and run \`${args.binary} <args>\`.`,
    );
  }
  const provider = await providerForBox(args.box);
  if (!provider.buildAttach) {
    throw new Error(`provider '${provider.name}' does not support interactive attach`);
  }
  // The trailing backslash-space lets the literal pass straight through the
  // outer shell-quoting layers without splitting `exec` and the binary name.
  const command = `bash -lc exec\\ ${args.binary}`;
  const spec = await provider.buildAttach(args.box, 'agent', {
    sessionName: args.sessionName,
    command,
  });
  try {
    const code = await runWrappedAttach({
      container: args.box.name,
      command: spec.argv[0],
      dockerArgv: spec.argv.slice(1),
      relayBaseUrl: RELAY_HOST_URL,
      boxId: args.box.id,
      boxName: args.box.name,
      projectIndex: args.box.projectIndex,
      mode: args.mode,
      detachable: true,
    });
    process.exit(code);
  } finally {
    if (spec.cleanup) await spec.cleanup();
  }
}
