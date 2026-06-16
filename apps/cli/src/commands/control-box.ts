import { confirm, isCancel, log, password, spinner } from '@clack/prompts';
import { Command } from 'commander';
import { setConfigValue, unsetConfigValue } from '@agentbox/config';
import { resolveRelayBin } from '@agentbox/sandbox-docker';
import {
  destroyControlBox,
  ensureHetznerEnvLoaded,
  provisionControlBox,
  readControlBoxState,
  setControlBoxToken,
} from '@agentbox/sandbox-hetzner';
import { handleLifecycleError } from './_errors.js';

interface CreateOpts {
  serverType?: string;
  location?: string;
  yes?: boolean;
}

const createSub = new Command('create')
  .description(
    'Provision an always-on Hetzner control box running the relay, so boxes keep pushing / opening PRs with your laptop off',
  )
  .option('--server-type <type>', 'Hetzner server type (default: cx23, the smallest current)')
  .option('--location <loc>', 'Hetzner location (default: nbg1)')
  .option('-y, --yes', 'skip the cost confirmation')
  .action(async (opts: CreateOpts) => {
    try {
      ensureHetznerEnvLoaded();
      const existing = readControlBoxState();
      if (existing) {
        log.warn(
          `A control box already exists at ${existing.url} (server ${String(existing.serverId)}). ` +
            'Run `agentbox control-box destroy` first to replace it.',
        );
        return;
      }
      if (!opts.yes) {
        const ok = await confirm({
          message:
            'This creates an always-on Hetzner VPS (smallest cx23, ~EUR6.5/mo, billed until destroyed). Continue?',
          initialValue: true,
        });
        if (isCancel(ok) || !ok) {
          log.info('Aborted.');
          return;
        }
      }

      const relayBinPath = resolveRelayBin();
      const s = spinner();
      s.start('provisioning control box');
      const { state } = await provisionControlBox({
        relayBinPath,
        serverType: opts.serverType,
        location: opts.location,
        onLog: (line) => s.message(line),
      });
      s.stop(`control box up at ${state.url}`);

      // Make the URL discoverable to the rest of the CLI (forwarder / box
      // registration resolve it from config). The admin token stays in the
      // 0600 state file, never in config.yaml.
      await setConfigValue('global', 'relay.controlBoxUrl', state.url, process.cwd());

      log.success(
        [
          `Control box ready: ${state.url}`,
          `  server:  ${String(state.serverId)} (${state.serverType} / ${state.location})`,
          `  ip:      ${state.ip}`,
          '',
          'Next: set the GitHub PAT it pushes with:',
          '  agentbox control-box set-token',
        ].join('\n'),
      );
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const setTokenSub = new Command('set-token')
  .description('Set or refresh the GitHub fine-grained PAT the control box pushes with')
  .action(async () => {
    try {
      ensureHetznerEnvLoaded();
      const state = readControlBoxState();
      if (!state) {
        log.error('No control box configured — run `agentbox control-box create` first.');
        process.exitCode = 1;
        return;
      }
      const pat = await password({
        message: 'Paste the GitHub fine-grained PAT (repo-scoped, short expiry)',
        validate: (v) => (v && v.trim().length > 0 ? undefined : 'Cannot be empty'),
      });
      if (isCancel(pat)) {
        log.info('Aborted.');
        return;
      }
      const s = spinner();
      s.start('pushing token to control box');
      await setControlBoxToken(pat, { onLog: (line) => s.message(line) });
      s.stop('token set; relay restarted');
      log.success('Control box can now push to GitHub. (Fine-grained PATs expire — re-run this to refresh.)');
    } catch (err) {
      handleLifecycleError(err);
    }
  });

interface StatusOpts {
  json?: boolean;
}

const statusSub = new Command('status')
  .description('Show the control box and whether its relay is reachable')
  .option('--json', 'emit JSON')
  .action(async (opts: StatusOpts) => {
    try {
      const state = readControlBoxState();
      if (!state) {
        if (opts.json) process.stdout.write(JSON.stringify({ configured: false }) + '\n');
        else process.stdout.write('control box: not configured\n');
        return;
      }
      let healthy = false;
      let detail = '';
      try {
        const res = await fetch(`${state.url}/healthz`, { signal: AbortSignal.timeout(8000) });
        healthy = res.ok;
        const body = (await res.json().catch(() => ({}))) as { version?: string; boxes?: number };
        detail = `version ${body.version ?? '?'}, ${String(body.boxes ?? 0)} box(es)`;
      } catch (e) {
        detail = e instanceof Error ? e.name : String(e);
      }
      if (opts.json) {
        process.stdout.write(JSON.stringify({ configured: true, healthy, ...state }, null, 2) + '\n');
        return;
      }
      process.stdout.write(
        [
          `control box: ${healthy ? 'reachable' : 'UNREACHABLE'}`,
          `  url:     ${state.url}`,
          `  server:  ${String(state.serverId)} (${state.serverType} / ${state.location})`,
          `  ip:      ${state.ip}`,
          `  relay:   ${detail}`,
        ].join('\n') + '\n',
      );
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const destroySub = new Command('destroy')
  .description('Tear down the control box (server + firewall) and clear local state')
  .option('-y, --yes', 'skip confirmation')
  .action(async (opts: { yes?: boolean }) => {
    try {
      ensureHetznerEnvLoaded();
      const state = readControlBoxState();
      if (!state) {
        log.info('No control box to destroy.');
        return;
      }
      if (!opts.yes) {
        const ok = await confirm({ message: `Destroy control box ${state.url} (server ${String(state.serverId)})?`, initialValue: false });
        if (isCancel(ok) || !ok) {
          log.info('Aborted.');
          return;
        }
      }
      const s = spinner();
      s.start('destroying control box');
      await destroyControlBox({ onLog: (line) => s.message(line) });
      s.stop('control box destroyed');
      await unsetConfigValue('global', 'relay.controlBoxUrl', process.cwd()).catch(() => {});
    } catch (err) {
      handleLifecycleError(err);
    }
  });

export const controlBoxCommand = new Command('control-box')
  .description('Manage an always-on control box (remote relay + GitHub PAT) for laptop-off git push / PRs')
  .addCommand(statusSub, { isDefault: true })
  .addCommand(createSub)
  .addCommand(setTokenSub)
  .addCommand(destroySub);
