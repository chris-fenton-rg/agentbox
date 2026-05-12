import { Command } from 'commander';
import { startCommand } from './commands/start.js';

const program = new Command();

program
  .name('agentbox')
  .description('Launch coding agents in isolated sandboxes')
  .version('0.0.0');

program.addCommand(startCommand);

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
