import { confirm, log } from '../lib/prompt.js';
import { Command } from 'commander';
import {
  DEFAULT_BOX_IMAGE,
  pullPiConfig,
  resolvePiVolume,
  SHARED_PI_VOLUME,
} from '@agentbox/sandbox-docker';
import { resolveBoxOrExit } from '../box-ref.js';
import { handleLifecycleError } from './_errors.js';

interface DownloadPiOpts {
  yes?: boolean;
  dryRun?: boolean;
}

export const downloadPiCommand = new Command('pi')
  .description(
    'Download box-side pi config/auth (auth.json, settings.json, models.json, extensions) back to host ~/.pi/agent (additive)',
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('-y, --yes', 'skip the confirmation prompt')
  .option('--dry-run', "list new items and exit; don't write")
  .action(async (idOrName: string | undefined, opts: DownloadPiOpts) => {
    try {
      const box = await resolveBoxOrExit(idOrName);

      // We read the pi-config *volume*, not the container, so the box can be
      // stopped — no unpause/start dance.
      const volume =
        box.piConfigVolume ?? resolvePiVolume({ isolate: false, boxId: box.id }).volume;
      if (volume === SHARED_PI_VOLUME) {
        log.warn(
          `Reading the shared ${SHARED_PI_VOLUME} volume — it aggregates pi config from ANY box, not just ${box.name}.`,
        );
      }
      const image = box.image || DEFAULT_BOX_IMAGE;

      const preview = await pullPiConfig({ volume }, { image, dryRun: true });

      if (preview.newItems.length === 0) {
        process.stdout.write('no new pi config to download into ~/.pi/agent\n');
        return;
      }

      for (const item of preview.newItems) process.stdout.write(`  ${item} (new)\n`);

      if (opts.dryRun) {
        process.stdout.write(
          `\n[dry-run] ${preview.newItems.length} item(s) would be downloaded into ~/.pi/agent\n`,
        );
        return;
      }

      if (!opts.yes) {
        const ok = await confirm({
          message: `Download ${preview.newItems.length} pi item(s) into ~/.pi/agent? (existing items are never overwritten)`,
          initialValue: false,
        });
        if (!ok) {
          log.info('cancelled');
          return;
        }
      }

      const result = await pullPiConfig({ volume }, { image, dryRun: false });
      process.stdout.write(`downloaded ${result.newItems.length} item(s) into ~/.pi/agent\n`);
    } catch (err) {
      handleLifecycleError(err);
    }
  });
