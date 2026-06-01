import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// `CHECKPOINTS_ROOT` is `join(homedir(), '.agentbox', 'checkpoints')`, captured
// at module-eval time. To redirect it at a tmp dir we must set HOME *before*
// the module is first imported — hence the dynamic import inside beforeAll
// (vitest isolates module graphs per test file, so this evaluates fresh).
let listAllCheckpoints: typeof import('../src/checkpoint.js').listAllCheckpoints;
let CHECKPOINTS_ROOT: string;
let tmpHome: string;
let originalHome: string | undefined;

async function writeManifest(segment: string, name: string, body: unknown): Promise<void> {
  const dir = join(CHECKPOINTS_ROOT, segment, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(body), 'utf8');
}

function manifest(name: string, createdAt: string): Record<string, unknown> {
  return {
    schema: 3,
    name,
    type: 'layered',
    image: `agentbox-ckpt-x:${name}`,
    parents: [],
    base: 'worktree',
    sourceBoxId: 'id',
    sourceBoxName: 'box',
    createdAt,
  };
}

beforeAll(async () => {
  originalHome = process.env.HOME;
  tmpHome = await mkdtemp(join(tmpdir(), 'agentbox-ckpt-all-'));
  process.env.HOME = tmpHome;
  const mod = await import('../src/checkpoint.js');
  listAllCheckpoints = mod.listAllCheckpoints;
  CHECKPOINTS_ROOT = mod.CHECKPOINTS_ROOT;
});

afterAll(async () => {
  process.env.HOME = originalHome;
  await rm(tmpHome, { recursive: true, force: true });
});

describe('listAllCheckpoints', () => {
  it('returns [] when the checkpoints root is missing', async () => {
    expect(await listAllCheckpoints()).toEqual([]);
  });

  it('groups by project segment, sorts items by createdAt, skips junk', async () => {
    await writeManifest('aaaa111122223333-proj_a', 'a-2', manifest('a-2', '2026-02-01T00:00:00Z'));
    await writeManifest('aaaa111122223333-proj_a', 'a-1', manifest('a-1', '2026-01-01T00:00:00Z'));
    await writeManifest('bbbb444455556666-proj_b', 'b-1', manifest('b-1', '2026-03-01T00:00:00Z'));
    // Unreadable manifest (bad schema) is skipped, not surfaced.
    await writeManifest('cccc777788889999-proj_c', 'c-1', { schema: 99, name: 'c-1' });
    // Segment dir with no valid manifest is dropped entirely.
    await mkdir(join(CHECKPOINTS_ROOT, 'dddd000011112222-proj_d'), { recursive: true });

    const groups = await listAllCheckpoints();
    const bySeg = new Map(groups.map((g) => [g.segment, g.items.map((i) => i.name)]));

    expect(bySeg.get('aaaa111122223333-proj_a')).toEqual(['a-1', 'a-2']);
    expect(bySeg.get('bbbb444455556666-proj_b')).toEqual(['b-1']);
    expect(bySeg.has('cccc777788889999-proj_c')).toBe(false);
    expect(bySeg.has('dddd000011112222-proj_d')).toBe(false);
  });
});
