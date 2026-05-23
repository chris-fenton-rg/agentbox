import { log } from '@clack/prompts';
import { Command } from 'commander';
import {
  ensureDaytonaCredentials,
  maskKey,
  readDaytonaCredStatus,
  secretsPath,
} from './credentials.js';

interface LoginOpts {
  status?: boolean;
}

function reportError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  log.error(message);
  process.exitCode = 1;
}

const loginSub = new Command('login')
  .description('Set up (or rotate) Daytona credentials for cloud boxes')
  .option('--status', 'show what is currently configured (masked) and exit')
  .action(async (opts: LoginOpts) => {
    try {
      if (opts.status) {
        printStatus();
        return;
      }
      if (!process.stdin.isTTY) {
        process.stderr.write(
          'daytona login needs an interactive terminal — set DAYTONA_API_KEY in the environment for non-interactive use.\n',
        );
        process.exitCode = 1;
        return;
      }
      await ensureDaytonaCredentials({ force: true });
    } catch (err) {
      reportError(err);
    }
  });

function printStatus(): void {
  const s = readDaytonaCredStatus();
  if (s.source === 'none') {
    process.stdout.write(
      'daytona: not configured\n' +
        '  run `agentbox daytona login` to set up credentials\n',
    );
    return;
  }
  const lines = ['daytona: configured', `  source: ${s.source}`];
  if (s.source === 'secrets.env') lines.push(`  file:   ${secretsPath()}`);
  if (s.apiKey) lines.push(`  apiKey: ${maskKey(s.apiKey)}`);
  if (s.jwtToken) lines.push(`  jwt:    ${maskKey(s.jwtToken)}`);
  if (s.organizationId) lines.push(`  orgId:  ${s.organizationId}`);
  process.stdout.write(lines.join('\n') + '\n');
}

export const daytonaCommand = new Command('daytona')
  .description('Daytona cloud-provider credential management')
  .addCommand(loginSub, { isDefault: true });
