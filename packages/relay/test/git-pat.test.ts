import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pushBundleToRemote, repoSlugFromRemote, toAuthedHttpsUrl } from '../src/git-pat.js';

describe('toAuthedHttpsUrl', () => {
  const TOKEN = 'github_pat_ABC123';

  it('rewrites scp-like ssh remotes', () => {
    expect(toAuthedHttpsUrl('git@github.com:owner/repo.git', TOKEN)).toBe(
      `https://x-access-token:${TOKEN}@github.com/owner/repo.git`,
    );
  });

  it('rewrites https remotes', () => {
    expect(toAuthedHttpsUrl('https://github.com/owner/repo.git', TOKEN)).toBe(
      `https://x-access-token:${TOKEN}@github.com/owner/repo.git`,
    );
  });

  it('rewrites ssh:// remotes', () => {
    expect(toAuthedHttpsUrl('ssh://git@github.com/owner/repo.git', TOKEN)).toBe(
      `https://x-access-token:${TOKEN}@github.com/owner/repo.git`,
    );
  });

  it('strips existing embedded credentials', () => {
    expect(toAuthedHttpsUrl('https://olduser:oldpass@github.com/owner/repo.git', TOKEN)).toBe(
      `https://x-access-token:${TOKEN}@github.com/owner/repo.git`,
    );
  });

  it('preserves enterprise hosts', () => {
    expect(toAuthedHttpsUrl('git@ghe.corp.example:team/svc.git', TOKEN)).toBe(
      `https://x-access-token:${TOKEN}@ghe.corp.example/team/svc.git`,
    );
  });

  it('throws on an unrecognized URL', () => {
    expect(() => toAuthedHttpsUrl('not a url', TOKEN)).toThrow(/unrecognized|empty/);
    expect(() => toAuthedHttpsUrl('', TOKEN)).toThrow(/empty/);
  });
});

describe('repoSlugFromRemote', () => {
  it('returns OWNER/REPO for github.com (https and ssh)', () => {
    expect(repoSlugFromRemote('https://github.com/owner/repo.git')).toBe('owner/repo');
    expect(repoSlugFromRemote('git@github.com:owner/repo.git')).toBe('owner/repo');
    expect(repoSlugFromRemote('https://github.com/owner/repo')).toBe('owner/repo');
  });

  it('prefixes the host for enterprise remotes', () => {
    expect(repoSlugFromRemote('git@ghe.corp.example:team/svc.git')).toBe('ghe.corp.example/team/svc');
  });
});

describe('pushBundleToRemote (local, no network)', () => {
  let root: string;
  const env = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e' };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agentbox-git-pat-test-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('pushes a bundle branch into a bare "origin" repo', async () => {
    // Source repo with one commit on `feature`.
    const src = join(root, 'src');
    await execa('git', ['init', '-q', '-b', 'main', src]);
    await execa('git', ['-C', src, 'checkout', '-q', '-b', 'feature']);
    await execa('bash', ['-c', `echo hi > ${join(src, 'f.txt')}`]);
    await execa('git', ['-C', src, 'add', '-A'], { env });
    await execa('git', ['-C', src, 'commit', '-q', '-m', 'first'], { env });
    const wantSha = (await execa('git', ['-C', src, 'rev-parse', 'feature'])).stdout.trim();

    // Bundle the branch (this is what the box produces).
    const bundle = join(root, 'op.bundle');
    await execa('git', ['-C', src, 'bundle', 'create', bundle, 'feature']);

    // Bare repo standing in for the GitHub remote.
    const origin = join(root, 'origin.git');
    await execa('git', ['init', '-q', '--bare', origin]);

    const result = await pushBundleToRemote({ bundlePath: bundle, branch: 'feature', remoteUrl: origin });
    expect(result.exitCode).toBe(0);
    expect(result.tipSha).toBe(wantSha);

    // Origin now has feature at the pushed tip.
    const got = (await execa('git', ['-C', origin, 'rev-parse', 'refs/heads/feature'])).stdout.trim();
    expect(got).toBe(wantSha);
  });

  it('reports a non-zero exit when the remote rejects the push', async () => {
    const src = join(root, 'src');
    await execa('git', ['init', '-q', '-b', 'feature', src]);
    await execa('bash', ['-c', `echo hi > ${join(src, 'f.txt')}`]);
    await execa('git', ['-C', src, 'add', '-A'], { env });
    await execa('git', ['-C', src, 'commit', '-q', '-m', 'first'], { env });
    const bundle = join(root, 'op.bundle');
    await execa('git', ['-C', src, 'bundle', 'create', bundle, 'feature']);

    const result = await pushBundleToRemote({
      bundlePath: bundle,
      branch: 'feature',
      remoteUrl: join(root, 'does-not-exist.git'),
    });
    expect(result.exitCode).not.toBe(0);
  });
});
