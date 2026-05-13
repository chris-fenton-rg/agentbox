import { Command } from 'commander';
import { claudeSessionCommand } from './commands/claude-session.js';
import { daemonCommand } from './commands/daemon.js';
import { statusCommand } from './commands/status.js';
import { logsCommand } from './commands/logs.js';
import { validateCommand } from './commands/validate.js';
import {
  reloadCommand,
  restartCommand,
  startServiceCommand,
  stopServiceCommand,
} from './commands/control.js';

const program = new Command();

program
  .name('agentbox-ctl')
  .description('In-container supervisor daemon and client for AgentBox')
  .version('0.0.0');

program.addCommand(daemonCommand);
program.addCommand(statusCommand);
program.addCommand(logsCommand);
program.addCommand(validateCommand);
program.addCommand(restartCommand);
program.addCommand(stopServiceCommand);
program.addCommand(startServiceCommand);
program.addCommand(reloadCommand);
program.addCommand(claudeSessionCommand);

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`agentbox-ctl: ${msg}\n`);
  process.exit(1);
});
