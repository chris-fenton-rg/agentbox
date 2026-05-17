import { spawn } from 'node:child_process';
import { log } from '@clack/prompts';
import { Command } from 'commander';
import { findProjectRoot } from '@agentbox/config';
import {
  buildClaudeAttachArgv,
  buildShellArgv,
  claudeSessionInfo,
  ensureBoxBrowser,
  listBoxes,
  rebuildPluginNativeDeps,
  startClaudeSession,
  type ListedBox,
} from '@agentbox/sandbox-docker';
import { resolveBoxOrExit } from '../box-ref.js';
import { Compositor, type RightTarget } from '../dashboard/compositor.js';
import type { PtySpawn, TerminalCtor } from '../dashboard/pty-session.js';
import type { SidebarBox } from '../dashboard/sidebar.js';
import { handleLifecycleError } from './_errors.js';

interface DashboardOptions {
  project?: boolean;
}

/**
 * Sidebar / switch order: group by project (so the global view doesn't
 * interleave per-project indices), then projectIndex, then name.
 */
function sortBoxes(boxes: ListedBox[]): ListedBox[] {
  return [...boxes].sort((a, b) => {
    const ap = a.projectRoot ?? '';
    const bp = b.projectRoot ?? '';
    if (ap !== bp) return ap.localeCompare(bp);
    const ai = a.projectIndex ?? Number.POSITIVE_INFINITY;
    const bi = b.projectIndex ?? Number.POSITIVE_INFINITY;
    if (ai !== bi) return ai - bi;
    return a.name.localeCompare(b.name);
  });
}

function scoped(all: boolean, projectRoot: string, boxes: ListedBox[]): ListedBox[] {
  return sortBoxes(all ? boxes : boxes.filter((b) => b.projectRoot === projectRoot));
}

function toSidebar(b: ListedBox): SidebarBox {
  return { id: b.id, name: b.name, state: b.state, claudeActivity: b.claudeActivity };
}

export const dashboardCommand = new Command('dashboard')
  .description(
    'Split-screen TUI: box list + the selected box live Claude session (pure Node, no tmux)',
  )
  .argument(
    '[box]',
    'initial box (default: first running box; -p restricts to the cwd project)',
  )
  .option('-p, --project', "only this project's boxes (default: all boxes globally)")
  .action(async (idOrName: string | undefined, opts: DashboardOptions) => {
    try {
      if (!process.stdout.isTTY || !process.stdin.isTTY) {
        log.error('agentbox dashboard needs an interactive terminal');
        process.exit(2);
      }

      // node-pty is an optionalDependency and @xterm/headless is CJS — both are
      // dynamic-imported here so a missing native prebuild (or the CJS named
      // export issue) degrades only the dashboard, never the rest of the CLI.
      let ptySpawn: PtySpawn;
      let termCtor: TerminalCtor;
      try {
        const ptyMod = (await import('@homebridge/node-pty-prebuilt-multiarch')) as Record<
          string,
          unknown
        >;
        const xtermMod = (await import('@xterm/headless')) as Record<string, unknown>;
        const spawn =
          (ptyMod['spawn'] as unknown) ??
          (ptyMod['default'] as Record<string, unknown> | undefined)?.['spawn'];
        const Terminal =
          (xtermMod['Terminal'] as unknown) ??
          (xtermMod['default'] as Record<string, unknown> | undefined)?.['Terminal'];
        if (typeof spawn !== 'function' || typeof Terminal !== 'function') {
          throw new Error('terminal backend missing expected exports');
        }
        ptySpawn = spawn as unknown as PtySpawn;
        termCtor = Terminal as unknown as TerminalCtor;
      } catch {
        log.error(
          'agentbox dashboard is unavailable here (native terminal backend failed to load)',
        );
        log.info('use `agentbox claude` / `agentbox claude attach` instead');
        process.exit(2);
      }

      const project = await findProjectRoot(process.cwd());
      let showAll = !opts.project; // default: every box globally; -p scopes to cwd project
      const full = await listBoxes();
      const scoped0 = scoped(showAll, project.root, full);

      let initialId: string;
      if (idOrName !== undefined) {
        const picked = await resolveBoxOrExit(idOrName);
        initialId = picked.id;
        if (!scoped0.some((b) => b.id === picked.id)) showAll = true; // widen so it shows
      } else {
        if (scoped0.length === 0) {
          log.error(
            opts.project ? `no boxes in this project (${project.root})` : 'no boxes exist',
          );
          log.info('run `agentbox create` to make one' + (opts.project ? ', or drop -p' : ''));
          process.exit(2);
        }
        initialId = (scoped0.find((b) => b.state === 'running') ?? scoped0[0]!).id;
      }

      const listCandidates = async (): Promise<SidebarBox[]> =>
        scoped(showAll, project.root, await listBoxes()).map(toSidebar);

      const resolveTarget = async (boxId: string): Promise<RightTarget> => {
        const box = (await listBoxes()).find((b) => b.id === boxId);
        if (!box) return { kind: 'placeholder', lines: ['', '  box not found'] };
        if (box.state !== 'running') {
          return {
            kind: 'placeholder',
            lines: ['', `  box ${box.name} is ${box.state}.`, `  Start it: agentbox start ${box.name}`],
          };
        }
        const info = await claudeSessionInfo(box.container);
        if (info.running) {
          return { kind: 'attach', argv: buildClaudeAttachArgv(box.container, info.sessionName) };
        }
        return { kind: 'menu' };
      };

      const findBox = async (boxId: string): Promise<ListedBox> => {
        const box = (await listBoxes()).find((b) => b.id === boxId);
        if (!box) throw new Error('box not found');
        if (box.state !== 'running') throw new Error(`box is ${box.state}`);
        return box;
      };

      const startClaude = async (boxId: string): Promise<RightTarget> => {
        const box = await findBox(boxId);
        // Idempotent + marker-gated: needed the first time a box that never ran
        // Claude starts one; a no-op afterwards. (No host ~/.claude re-sync —
        // already synced at `agentbox create`; == `claude start --no-sync-config`.)
        await rebuildPluginNativeDeps(box.container, {
          volume: box.claudeConfigVolume,
        });
        await startClaudeSession({ container: box.container, claudeArgs: [] });
        const info = await claudeSessionInfo(box.container);
        return {
          kind: 'attach',
          argv: buildClaudeAttachArgv(box.container, info.sessionName),
          mode: 'claude',
        };
      };

      const openShell = async (boxId: string): Promise<RightTarget> => {
        const box = await findBox(boxId);
        return { kind: 'attach', argv: buildShellArgv(box.container), mode: 'shell' };
      };

      // Detached + stdio ignored: never blocks the dashboard loop and can't
      // write into the alt-screen. (`open` mirrors browser.ts but not
      // spawnSync/inherit, which would corrupt the TUI.)
      const detach = (cmd: string, args: string[]): void => {
        spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
      };

      const findEndpointUrl = async (
        boxId: string,
        kind: 'vnc' | 'web',
      ): Promise<{ name: string; url: string | null }> => {
        const box = (await listBoxes()).find((b) => b.id === boxId);
        if (!box) return { name: boxId, url: null };
        const ep = box.endpoints.endpoints.find((e) => e.kind === kind);
        return { name: box.name, url: ep && ep.reachable && ep.url ? ep.url : null };
      };

      const openVnc = async (boxId: string): Promise<string> => {
        const { url } = await findEndpointUrl(boxId, 'vnc');
        if (!url) return 'VNC not available for this box';
        try {
          const box = await findBox(boxId);
          const br = await ensureBoxBrowser(box.container);
          if (!br.up) return `VNC: in-box browser unavailable (${br.reason ?? 'box not running?'})`;
        } catch {
          // Best-effort — still open the viewer even if the box isn't running.
        }
        detach('open', [url]);
        return 'Opening VNC in browser…';
      };

      const openWeb = async (boxId: string): Promise<string> => {
        const box = (await listBoxes()).find((b) => b.id === boxId);
        if (!box) return 'box not found';
        const ep = box.endpoints.endpoints.find((e) => e.kind === 'web');
        // Prefer the published web endpoint when a service declares `expose:`;
        // otherwise just open the box domain (e.g. <box>.orb.local) regardless.
        const url = ep && ep.reachable && ep.url ? ep.url : `http://${box.endpoints.domain}`;
        detach('open', [url]);
        return `Opening ${url.replace(/^https?:\/\//, '')}…`;
      };

      const openCode = async (boxId: string): Promise<string> => {
        const box = (await listBoxes()).find((b) => b.id === boxId);
        if (!box) return 'box not found';
        // Reuse the real `agentbox code` out-of-process (IDE detection,
        // code→cursor fallback) without its up-to-120s wait-ready blocking us.
        detach(process.execPath, [process.argv[1]!, 'code', box.name, '--no-wait']);
        return 'Launching VS Code / Cursor…';
      };

      const compositor = new Compositor(
        {
          ptySpawn,
          termCtor,
          listCandidates,
          resolveTarget,
          startClaude,
          openShell,
          openVnc,
          openCode,
          openWeb,
        },
        initialId,
      );
      await compositor.run();
      process.exit(0);
    } catch (err) {
      handleLifecycleError(err);
    }
  });
