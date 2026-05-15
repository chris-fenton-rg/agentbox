import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEffectiveConfig, loadProjectAgentboxDefaults } from '../src/load.js';

// HOME is overridden by ./setup.ts to a fresh temp dir per test file. We do
// NOT create ~/.agentbox/* here, so every load below sees ENOENT and must
// return the empty layer.

let tmpCwd: string;

beforeEach(async () => {
  tmpCwd = await mkdtemp(join(tmpdir(), 'agentbox-cfg-enoent-'));
});

afterEach(async () => {
  await rm(tmpCwd, { recursive: true, force: true });
});

describe('ENOENT tolerance', () => {
  it('loadEffectiveConfig falls back to built-in defaults', async () => {
    const r = await loadEffectiveConfig(tmpCwd);
    expect(r.layers.global.values).toEqual({});
    expect(r.layers.project.values).toEqual({});
    expect(r.layers.workspace.path).toBeNull();
    expect(r.effective.box.withPlaywright).toBe(false);
    expect(r.effective.engine.kind).toBe('auto');
    expect(r.sources['box.withPlaywright']).toBe('default');
  });

  it('loadProjectAgentboxDefaults returns {} when agentbox.yaml is missing', async () => {
    const d = await loadProjectAgentboxDefaults(tmpCwd);
    expect(d).toEqual({});
  });
});
