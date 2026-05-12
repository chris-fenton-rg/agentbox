import { Command } from 'commander';

export const startCommand = new Command('start')
  .description('Start a new agent box')
  .option('-a, --agent <name>', 'agent to launch (claude-code | codex | ...)', 'claude-code')
  .option(
    '-p, --provider <name>',
    'sandbox provider (docker | e2b | modal | daytona | vercel)',
    'docker',
  )
  .option('-w, --workspace <path>', 'host workspace to mount', process.cwd())
  .action((opts: { agent: string; provider: string; workspace: string }) => {
    console.log('agentbox start — not yet implemented');
    console.log(`  agent:     ${opts.agent}`);
    console.log(`  provider:  ${opts.provider}`);
    console.log(`  workspace: ${opts.workspace}`);
  });
