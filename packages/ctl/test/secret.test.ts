import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAutoSecrets } from '../src/secret.js';

describe('resolveAutoSecrets', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ctl-secret-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const opts = () => ({ stateDir: dir, logDir: dir });

  it('leaves content without the token untouched (no state-dir write)', async () => {
    const out = await resolveAutoSecrets('PORT=3000\n', opts());
    expect(out).toBe('PORT=3000\n');
    expect(existsSync(join(dir, 'secrets'))).toBe(false);
  });

  it('replaces an unnamed token with a 43-char base64url secret', async () => {
    const out = await resolveAutoSecrets('S="{{AGENTBOX_AUTO_SECRET}}"\n', opts());
    const m = out.match(/^S="([A-Za-z0-9_-]+)"$/m);
    expect(m).toBeTruthy();
    expect(m![1]!.length).toBe(43); // 32 bytes base64url
  });

  it('regenerates a fresh secret each render for unnamed tokens', async () => {
    const a = await resolveAutoSecrets('{{AGENTBOX_AUTO_SECRET}}', opts());
    const b = await resolveAutoSecrets('{{AGENTBOX_AUTO_SECRET}}', opts());
    expect(a).not.toBe(b);
  });

  it('persists and reuses a named secret across renders', async () => {
    const first = await resolveAutoSecrets('{{AGENTBOX_AUTO_SECRET:better-auth}}', opts());
    expect(existsSync(join(dir, 'secrets', 'better-auth'))).toBe(true);
    const second = await resolveAutoSecrets('{{AGENTBOX_AUTO_SECRET:better-auth}}', opts());
    expect(second).toBe(first); // reused, not regenerated
    expect(readFileSync(join(dir, 'secrets', 'better-auth'), 'utf8').trim()).toBe(first);
  });

  it('uses the same value for repeated occurrences of one named token', async () => {
    const out = await resolveAutoSecrets(
      'A={{AGENTBOX_AUTO_SECRET:k}} B={{AGENTBOX_AUTO_SECRET:k}}',
      opts(),
    );
    const [, a, b] = out.match(/^A=(\S+) B=(\S+)$/)!;
    expect(a).toBe(b);
  });
});
