import { randomBytes } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { ConfigError, loadConfig } from '@agentbox/ctl';
import { containerExists, dockerInfo, ensureVolume, runBox } from './docker.js';
import { DEFAULT_BOX_IMAGE, ensureImage } from './image.js';
import { mountOverlay, verifyOverlay, type OverlayCheck } from './overlay.js';
import { recordBox, type BoxRecord } from './state.js';
import { createSnapshot, snapshotPathFor } from './snapshot.js';
import { launchCtlDaemon } from './ctl.js';

export interface CreateBoxOptions {
  workspacePath: string;
  name?: string;
  useSnapshot: boolean;
  image?: string;
  onLog?: (line: string) => void;
}

export interface CreatedBox {
  record: BoxRecord;
  overlayChecks: OverlayCheck[];
  imageBuilt: boolean;
}

function generateBoxId(): string {
  return randomBytes(4).toString('hex');
}

export function sanitizeBasename(workspacePath: string): string {
  const raw = basename(resolve(workspacePath));
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 30)
    .replace(/[-._]+$/, '');
}

export function defaultBoxName(workspacePath: string, id: string): string {
  const base = sanitizeBasename(workspacePath);
  return base.length > 0 ? `${base}-${id}` : id;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function buildAgentMounts(): Promise<string[]> {
  const home = homedir();
  const candidates: Array<{ src: string; dst: string; readOnly: boolean }> = [
    { src: join(home, '.claude'), dst: '/home/vscode/.claude', readOnly: false },
    { src: join(home, '.codex'), dst: '/home/vscode/.codex', readOnly: false },
    { src: join(home, '.gitconfig'), dst: '/home/vscode/.gitconfig', readOnly: true },
  ];
  const out: string[] = [];
  for (const c of candidates) {
    if (await pathExists(c.src)) {
      out.push(`${c.src}:${c.dst}${c.readOnly ? ':ro' : ''}`);
    }
  }
  return out;
}

export async function createBox(opts: CreateBoxOptions): Promise<CreatedBox> {
  const log = opts.onLog ?? (() => {});
  const workspace = resolve(opts.workspacePath);
  if (!(await pathExists(workspace))) {
    throw new Error(`workspace does not exist: ${workspace}`);
  }

  // Pre-flight agentbox.yaml validation on the host so the user sees the real
  // ConfigError instead of an opaque "socket did not appear" timeout from the
  // detached daemon exec later. The daemon re-validates inside the box anyway
  // — defence in depth, and necessary because the file lives in the overlay
  // and can be edited after create.
  const cfgPath = join(workspace, 'agentbox.yaml');
  if (await pathExists(cfgPath)) {
    try {
      const cfg = await loadConfig(cfgPath);
      log(`agentbox.yaml validated (${String(cfg.services.length)} service(s))`);
    } catch (err) {
      if (err instanceof ConfigError) {
        throw new Error(`agentbox.yaml validation failed:\n  ${err.message}`);
      }
      throw err;
    }
  }

  await dockerInfo();
  log('docker daemon reachable');

  const imageRef = opts.image ?? DEFAULT_BOX_IMAGE;
  const { built } = await ensureImage(imageRef, {
    onProgress: (line) => log(`[image] ${line}`),
  });
  log(built ? `built image ${imageRef}` : `using cached image ${imageRef}`);

  const id = generateBoxId();
  const name = opts.name ?? defaultBoxName(workspace, id);
  const containerName = `agentbox-${name}`;
  if (await containerExists(containerName)) {
    throw new Error(`container ${containerName} already exists; remove it first`);
  }

  let lowerPath = workspace;
  let snapshotDir: string | null = null;
  if (opts.useSnapshot) {
    snapshotDir = snapshotPathFor(id);
    log(`cloning workspace to ${snapshotDir} (APFS clone where available)`);
    const snap = await createSnapshot({ source: workspace, destination: snapshotDir });
    log(`pruned ${snap.prunedPaths.length} platform-dependent dirs from snapshot`);
    lowerPath = snapshotDir;
  }

  const upperVolume = `agentbox-upper-${id}`;
  const nodeModulesVolume = `agentbox-nm-${id}`;
  await ensureVolume(upperVolume);
  await ensureVolume(nodeModulesVolume);
  log(`prepared volumes ${upperVolume}, ${nodeModulesVolume}`);

  const socketDir = join(homedir(), '.agentbox', 'boxes', id, 'run');
  const socketPath = join(socketDir, 'ctl.sock');
  await mkdir(socketDir, { recursive: true });

  const extraVolumes = await buildAgentMounts();
  extraVolumes.push(`${socketDir}:/run/agentbox`);
  for (const v of extraVolumes) log(`mounting agent dir: ${v}`);

  await runBox({
    name: containerName,
    image: imageRef,
    lowerPath,
    upperVolume,
    nodeModulesVolume,
    extraVolumes,
    env: { AGENTBOX_BOX_ID: id },
  });
  log(`container ${containerName} started`);

  try {
    await mountOverlay(containerName);
    log('fuse-overlayfs mounted at /workspace');
  } catch (err) {
    log(`overlay mount failed; leaving container ${containerName} running so you can inspect it`);
    throw err;
  }

  const overlayChecks = await verifyOverlay(containerName);
  const failed = overlayChecks.filter((c) => !c.ok);
  if (failed.length > 0) {
    const detail = failed.map((c) => `  - ${c.name}: ${c.detail}`).join('\n');
    throw new Error(`overlay verification failed:\n${detail}`);
  }
  log('overlay verified');

  const ctl = await launchCtlDaemon(containerName, socketPath);
  if (ctl.up) log('agentbox-ctl daemon up');
  else log(`agentbox-ctl daemon did not become reachable: ${ctl.reason}`);

  const record: BoxRecord = {
    id,
    name,
    container: containerName,
    image: imageRef,
    workspacePath: workspace,
    lowerPath,
    upperVolume,
    nodeModulesVolume,
    snapshotDir,
    socketPath,
    createdAt: new Date().toISOString(),
  };
  await recordBox(record);

  return { record, overlayChecks, imageBuilt: built };
}
