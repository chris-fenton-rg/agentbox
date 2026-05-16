import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { hashProjectPath, setConfigValue } from '@agentbox/config';
import { ensureVolume } from './docker.js';
import { DEFAULT_BOX_IMAGE } from './image.js';
import type { BoxRecord } from './state.js';

export const CHECKPOINTS_ROOT = join(homedir(), '.agentbox', 'checkpoints');

/** All per-project checkpoint volumes share this prefix (prune allowlist). */
export const CHECKPOINT_VOLUME_PREFIX = 'agentbox-ckpt-';

/** Read-only mount point of the per-project checkpoint volume inside a box. */
export const CHECKPOINT_MOUNT = '/agentbox-checkpoints';

/**
 * One Docker volume per project; each checkpoint is a `<name>` subdir inside
 * it. Deterministic from the project root (same hash the per-project config
 * dir uses), so it survives box destroy and is shared read-only across boxes.
 * Pure — unit-tested directly.
 */
export function checkpointVolumeName(projectRoot: string): string {
  return `${CHECKPOINT_VOLUME_PREFIX}${hashProjectPath(projectRoot)}`;
}

export type CheckpointType = 'layered' | 'merged';

export interface CheckpointManifest {
  schema: 1;
  name: string;
  type: CheckpointType;
  /**
   * For a layered checkpoint, the older checkpoint refs this delta stacks on
   * (upper-most first, base-most last) — i.e. the chain the *source* box was
   * built from. `[]` for a merged checkpoint (self-contained) or a layered
   * checkpoint taken from a box that itself started from bare host code.
   */
  parents: string[];
  base: 'worktree' | 'workspace';
  sourceBoxId: string;
  sourceBoxName: string;
  /** Per-project Docker volume the captured tree lives in (subdir = `name`). */
  volume: string;
  createdAt: string;
}

export interface CheckpointInfo {
  name: string;
  /** Host dir holding `manifest.json` (`~/.agentbox/checkpoints/<hash>/<name>`). */
  dir: string;
  manifest: CheckpointManifest;
}

/** Resolved lower spec a new box should mount when starting from a checkpoint. */
export interface CheckpointLowerSpec {
  type: CheckpointType;
  /** The single per-project checkpoint volume (mounted ro once at CHECKPOINT_MOUNT). */
  volume: string;
  /**
   * Checkpoint subdir names within `volume`, upper-most first. For `layered`
   * the caller appends the base lower (`/host-src`) after these; for `merged`
   * this is the sole lower (single entry).
   */
  subpaths: string[];
  /** Checkpoint refs composing the chain, base-most last (for BoxRecord.checkpointSource). */
  chain: string[];
}

export function projectCheckpointsDir(projectRoot: string): string {
  return join(CHECKPOINTS_ROOT, hashProjectPath(projectRoot));
}

function checkpointDir(projectRoot: string, name: string): string {
  return join(projectCheckpointsDir(projectRoot), name);
}

async function readManifest(dir: string): Promise<CheckpointManifest | null> {
  try {
    const raw = await readFile(join(dir, 'manifest.json'), 'utf8');
    const m = JSON.parse(raw) as CheckpointManifest;
    if (m.schema !== 1) return null;
    return m;
  } catch {
    return null;
  }
}

export async function listCheckpoints(projectRoot: string): Promise<CheckpointInfo[]> {
  const root = projectCheckpointsDir(projectRoot);
  let entries: string[];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out: CheckpointInfo[] = [];
  for (const name of entries) {
    const dir = join(root, name);
    const manifest = await readManifest(dir);
    if (manifest) out.push({ name, dir, manifest });
  }
  out.sort((a, b) => a.manifest.createdAt.localeCompare(b.manifest.createdAt));
  return out;
}

export async function resolveCheckpoint(
  projectRoot: string,
  ref: string,
): Promise<CheckpointInfo | null> {
  const dir = checkpointDir(projectRoot, ref);
  const manifest = await readManifest(dir);
  if (!manifest) return null;
  return { name: ref, dir, manifest };
}

export async function removeCheckpoint(projectRoot: string, ref: string): Promise<boolean> {
  const dir = checkpointDir(projectRoot, ref);
  const manifest = await readManifest(dir);
  if (!manifest) return false;
  await rm(dir, { recursive: true, force: true });
  // Delete only this checkpoint's subdir; the per-project volume stays for the
  // project's other checkpoints. Best-effort (volume may already be gone).
  const volume = manifest.volume || checkpointVolumeName(projectRoot);
  await execa(
    'docker',
    ['run', '--rm', '--user', '0:0', '-v', `${volume}:/dst`, DEFAULT_BOX_IMAGE, 'rm', '-rf', `/dst/${ref}`],
    { reject: false },
  );
  return true;
}

/**
 * Next `<boxName>-<n>` given the names already present. Monotonic per
 * box-name; gaps from deleted checkpoints are skipped (max+1, never
 * recycled). Pure — unit-tested directly.
 */
export function computeNextCheckpointName(existingNames: string[], boxName: string): string {
  const re = new RegExp(`^${boxName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`);
  let max = 0;
  for (const n of existingNames) {
    const m = re.exec(n);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${boxName}-${String(max + 1)}`;
}

async function nextCheckpointName(projectRoot: string, boxName: string): Promise<string> {
  const existing = await listCheckpoints(projectRoot);
  return computeNextCheckpointName(
    existing.map((c) => c.name),
    boxName,
  );
}

function chainDepth(box: BoxRecord): number {
  return box.checkpointSource?.chain.length ?? 0;
}

/** Quote a string for safe single-quoted embedding in a bash -lc script. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface CreateCheckpointOptions {
  box: BoxRecord;
  projectRoot: string;
  name?: string;
  merged?: boolean;
  setDefault?: boolean;
  /** checkpoint.maxLayers — auto-merge when the source chain is at/over this. */
  maxLayers: number;
  onLog?: (line: string) => void;
}

/**
 * Capture a box's accumulated state as a project checkpoint, into a `<name>`
 * subdir of the per-project Docker volume.
 *
 *  - `layered`: copy the box's overlay write delta (`/upper/upper`, which now
 *    holds node_modules/build caches/env files) volume→volume in a throwaway
 *    root container. The destination is ext4, so overlay char-device whiteouts
 *    survive `cp -a` natively (no `.wh.` translation needed) and the copy
 *    never crosses the VM↔host bridge.
 *  - `merged`: tar the box's merged `/workspace` (everything) into the subdir,
 *    used later as a single sole lower.
 *
 * Merged is chosen when `--merged` is passed or the source box's checkpoint
 * chain is already `>= maxLayers` deep (caps the lowerdir stack).
 */
export async function createCheckpoint(opts: CreateCheckpointOptions): Promise<CheckpointInfo> {
  const log = opts.onLog ?? (() => {});
  const { box } = opts;

  const type: CheckpointType =
    opts.merged === true || chainDepth(box) >= opts.maxLayers ? 'merged' : 'layered';
  const name = opts.name ?? (await nextCheckpointName(opts.projectRoot, box.name));
  const dir = checkpointDir(opts.projectRoot, name);
  if (await readManifest(dir)) {
    throw new CheckpointError(`checkpoint ${name} already exists (rm it first)`, '', '');
  }
  const volume = checkpointVolumeName(opts.projectRoot);
  await ensureVolume(volume);
  await mkdir(dir, { recursive: true });
  const qn = shq(name);

  if (type === 'layered') {
    log(`capturing upper delta of ${box.container} -> ${volume}/${name} (layered)`);
    // Volume→volume copy in a throwaway root container: all VM-local ext4, no
    // virtiofs bridge crossing, and overlay char-device whiteouts are
    // preserved as-is (fuse-overlayfs honors them in a lowerdir).
    const script = [
      'set -u',
      `rm -rf /dst/${qn}`,
      `mkdir -p /dst/${qn}`,
      `cp -a /src/upper/. /dst/${qn}/ 2>/dev/null || true`,
      `ls -A /dst/${qn} >/dev/null`,
    ].join('\n');
    const r = await execa(
      'docker',
      [
        'run',
        '--rm',
        '--user',
        '0:0',
        '-v',
        `${box.upperVolume}:/src:ro`,
        '-v',
        `${volume}:/dst`,
        box.image,
        'bash',
        '-lc',
        script,
      ],
      { reject: false },
    );
    if (r.exitCode !== 0) {
      throw new CheckpointError(`failed to copy upper layer for ${box.name}`, r.stdout, r.stderr);
    }
  } else {
    log(`capturing merged /workspace of ${box.container} -> ${volume}/${name} (merged)`);
    const packed = await execa(
      'docker',
      ['exec', '--user', 'root', box.container, 'tar', '-C', '/workspace', '-cf', '-', '.'],
      { reject: false, encoding: 'buffer' },
    );
    if (packed.exitCode !== 0) {
      throw new CheckpointError(
        `failed to tar merged /workspace for ${box.name} (is the box running?)`,
        '',
        typeof packed.stderr === 'string'
          ? packed.stderr
          : (packed.stderr as Buffer).toString('utf8'),
      );
    }
    const extract = await execa(
      'docker',
      [
        'run',
        '-i',
        '--rm',
        '--user',
        '0:0',
        '-v',
        `${volume}:/dst`,
        box.image,
        'bash',
        '-lc',
        `set -u; rm -rf /dst/${qn}; mkdir -p /dst/${qn}; tar -xf - -C /dst/${qn}`,
      ],
      { input: packed.stdout as Buffer, reject: false },
    );
    if (extract.exitCode !== 0) {
      throw new CheckpointError(
        'tar extract into checkpoint volume failed',
        extract.stdout,
        extract.stderr,
      );
    }
  }

  const base: 'worktree' | 'workspace' = (box.gitWorktrees ?? []).some((w) => w.kind === 'root')
    ? 'worktree'
    : 'workspace';
  const manifest: CheckpointManifest = {
    schema: 1,
    name,
    type,
    parents: type === 'layered' ? (box.checkpointSource?.chain ?? []) : [],
    base,
    sourceBoxId: box.id,
    sourceBoxName: box.name,
    volume,
    createdAt: new Date().toISOString(),
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  if (opts.setDefault) {
    await setConfigValue('project', 'box.defaultCheckpoint', name, opts.projectRoot);
    log(`set project default checkpoint -> ${name}`);
  }

  return { name, dir, manifest };
}

/**
 * Resolve the lower spec a new box should stack when starting from checkpoint
 * `ref`. All layers in a chain live in the one per-project volume, so the box
 * mounts it once; `subpaths` are the per-layer subdir names (upper-most
 * first). For `layered` the caller appends the base lower after these; for
 * `merged` `subpaths` is the sole lower.
 */
export async function resolveCheckpointLower(
  projectRoot: string,
  ref: string,
): Promise<CheckpointLowerSpec> {
  const head = await resolveCheckpoint(projectRoot, ref);
  if (!head) throw new CheckpointError(`checkpoint not found: ${ref}`, '', '');
  if (!head.manifest.volume) {
    throw new CheckpointError(
      `checkpoint ${ref} is a legacy host-dir checkpoint; recreate it`,
      '',
      '',
    );
  }
  const volume = head.manifest.volume;

  if (head.manifest.type === 'merged') {
    return { type: 'merged', volume, subpaths: [head.name], chain: [head.name] };
  }

  const subpaths = [head.name];
  const chain = [head.name];
  for (const parentRef of head.manifest.parents) {
    const p = await resolveCheckpoint(projectRoot, parentRef);
    if (!p) {
      throw new CheckpointError(
        `checkpoint ${ref} references missing parent ${parentRef}`,
        '',
        '',
      );
    }
    subpaths.push(p.name);
    chain.push(p.name);
  }
  return { type: 'layered', volume, subpaths, chain };
}

export class CheckpointError extends Error {
  constructor(
    message: string,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(`${message}${stderr ? `: ${stderr.trim()}` : ''}`);
    this.name = 'CheckpointError';
  }
}
