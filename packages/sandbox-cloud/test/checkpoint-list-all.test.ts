import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// `CLOUD_CHECKPOINTS_ROOT` is captured at module-eval time, so HOME must be set
// before the first import. Dynamic-import inside beforeAll (vitest isolates
// module graphs per file) keeps the root pointed at a tmp dir.
let listAllCloudCheckpoints: typeof import('../src/checkpoint.js').listAllCloudCheckpoints;
let CLOUD_CHECKPOINTS_ROOT: string;
let tmpHome: string;
let originalHome: string | undefined;

async function writeManifest(
  backend: string,
  segment: string,
  name: string,
  body: unknown,
): Promise<void> {
  const dir = join(CLOUD_CHECKPOINTS_ROOT, backend, segment, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(body), 'utf8');
}

function manifest(name: string, backend: string, createdAt: string): Record<string, unknown> {
  return {
    schema: 2,
    name,
    backend,
    snapshotName: `agentbox-ckpt-x-${name}`,
    sourceBoxId: 'id',
    sourceBoxName: 'box',
    createdAt,
  };
}

beforeAll(async () => {
  originalHome = process.env.HOME;
  tmpHome = await mkdtemp(join(tmpdir(), 'agentbox-cloud-ckpt-all-'));
  process.env.HOME = tmpHome;
  const mod = await import('../src/checkpoint.js');
  listAllCloudCheckpoints = mod.listAllCloudCheckpoints;
  CLOUD_CHECKPOINTS_ROOT = mod.CLOUD_CHECKPOINTS_ROOT;
});

afterAll(async () => {
  process.env.HOME = originalHome;
  await rm(tmpHome, { recursive: true, force: true });
});

describe('listAllCloudCheckpoints', () => {
  it('returns [] when a backend has no checkpoints', async () => {
    expect(await listAllCloudCheckpoints('daytona')).toEqual([]);
  });

  it('groups by project segment, sorts by createdAt, scoped per backend', async () => {
    await writeManifest('daytona', 'aaaa111122223333-proj_a', 's-2', manifest('s-2', 'daytona', '2026-02-01T00:00:00Z'));
    await writeManifest('daytona', 'aaaa111122223333-proj_a', 's-1', manifest('s-1', 'daytona', '2026-01-01T00:00:00Z'));
    await writeManifest('daytona', 'bbbb444455556666-proj_b', 's-1', manifest('s-1', 'daytona', '2026-03-01T00:00:00Z'));
    // A hetzner checkpoint must not leak into the daytona listing.
    await writeManifest('hetzner', 'cccc777788889999-proj_c', 'h-1', manifest('h-1', 'hetzner', '2026-01-01T00:00:00Z'));
    // Bad schema skipped; empty segment dir dropped.
    await writeManifest('daytona', 'dddd000011112222-proj_d', 'd-1', { schema: 99 });
    await mkdir(join(CLOUD_CHECKPOINTS_ROOT, 'daytona', 'eeee000011112222-proj_e'), { recursive: true });

    const daytona = await listAllCloudCheckpoints('daytona');
    const bySeg = new Map(daytona.map((g) => [g.segment, g.items.map((i) => i.name)]));

    expect(bySeg.get('aaaa111122223333-proj_a')).toEqual(['s-1', 's-2']);
    expect(bySeg.get('bbbb444455556666-proj_b')).toEqual(['s-1']);
    expect(bySeg.has('cccc777788889999-proj_c')).toBe(false);
    expect(bySeg.has('dddd000011112222-proj_d')).toBe(false);
    expect(bySeg.has('eeee000011112222-proj_e')).toBe(false);

    const hetzner = await listAllCloudCheckpoints('hetzner');
    expect(hetzner.map((g) => g.segment)).toEqual(['cccc777788889999-proj_c']);
  });
});
