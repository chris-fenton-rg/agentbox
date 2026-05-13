import { log } from '@clack/prompts';
import { Command } from 'commander';
import { renderStatusTable, type ClaudeSessionStatus, type ServiceStatus } from '@agentbox/ctl';
import {
  AmbiguousBoxError,
  BoxNotFoundError,
  execInBox,
  findBox,
  readState,
} from '@agentbox/sandbox-docker';
import { handleLifecycleError } from './_errors.js';

interface StatusOptions {
  json?: boolean;
}

export const statusCommand = new Command('status')
  .description("Show service status from a box's agentbox-ctl daemon")
  .argument('<box>', 'box id, id prefix, name, or container name')
  .option('-j, --json', 'machine-readable JSON output')
  .action(async (idOrName: string, opts: StatusOptions) => {
    try {
      const state = await readState();
      const result = findBox(idOrName, state);
      if (result.kind === 'none') throw new BoxNotFoundError(idOrName);
      if (result.kind === 'ambiguous') throw new AmbiguousBoxError(idOrName, result.matches);
      const box = result.box;

      // Cross the docker boundary via `docker exec`: macOS hosts can see the
      // socket file in the bind mount but can't actually connect to it. The
      // daemon is reachable from the container itself, so we shell in.
      const proc = await execInBox(box.container, ['agentbox-ctl', 'status', '--json'], {
        user: 'vscode',
      });
      if (proc.exitCode !== 0) {
        log.error(`agentbox-ctl status failed: ${proc.stderr || proc.stdout}`);
        process.exit(1);
      }
      const list = JSON.parse(proc.stdout) as ServiceStatus[];
      const claude = await fetchClaudeSession(box.container);

      if (opts.json) {
        process.stdout.write(JSON.stringify({ services: list, claudeSession: claude }, null, 2) + '\n');
      } else {
        if (claude !== null) {
          process.stdout.write(`${renderClaudeLine(claude)}\n`);
        }
        process.stdout.write(renderStatusTable(list) + '\n');
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });

async function fetchClaudeSession(container: string): Promise<ClaudeSessionStatus | null> {
  const proc = await execInBox(container, ['agentbox-ctl', 'claude-session', '--json'], {
    user: 'vscode',
  });
  if (proc.exitCode !== 0) return null;
  try {
    return JSON.parse(proc.stdout) as ClaudeSessionStatus;
  } catch {
    return null;
  }
}

function renderClaudeLine(s: ClaudeSessionStatus): string {
  if (!s.running) return `claude session: not running ("${s.sessionName}")`;
  const since = s.startedAt ? ` since ${s.startedAt}` : '';
  return `claude session: running ("${s.sessionName}")${since}`;
}
