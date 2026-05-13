import { Command } from 'commander';
import { claudeSession } from '../client.js';
import { DEFAULT_CLAUDE_SESSION_NAME, DEFAULT_SOCKET_PATH } from '../types.js';

interface ClaudeSessionOptions {
  socket: string;
  sessionName: string;
  json?: boolean;
}

export const claudeSessionCommand = new Command('claude-session')
  .description('Report whether a Claude Code tmux session is running in this box')
  .option('--socket <path>', 'unix socket path', DEFAULT_SOCKET_PATH)
  .option('--session-name <name>', 'tmux session name', DEFAULT_CLAUDE_SESSION_NAME)
  .option('-j, --json', 'machine-readable JSON output')
  .action(async (opts: ClaudeSessionOptions) => {
    const info = await claudeSession({
      socketPath: opts.socket,
      sessionName: opts.sessionName,
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(info, null, 2) + '\n');
      return;
    }
    if (info.running) {
      process.stdout.write(
        `claude session "${info.sessionName}" running${info.startedAt ? ` since ${info.startedAt}` : ''}\n`,
      );
    } else {
      process.stdout.write(`no claude session "${info.sessionName}"\n`);
    }
  });
