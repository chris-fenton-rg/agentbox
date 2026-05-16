import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('detectEngine', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('execa');
  });

  async function loadWithDockerInfoOs(os: string): Promise<typeof import('../src/host-export.js')> {
    vi.doMock('execa', () => ({
      execa: vi.fn(async () => ({ stdout: os, stderr: '', exitCode: 0 })),
    }));
    const mod = await import('../src/host-export.js');
    mod.__setEngineForTesting(null);
    return mod;
  }

  it('detects OrbStack', async () => {
    const mod = await loadWithDockerInfoOs('OrbStack');
    expect(await mod.detectEngine()).toBe('orbstack');
  });

  it('detects Docker Desktop', async () => {
    const mod = await loadWithDockerInfoOs('Docker Desktop 4.30.0');
    expect(await mod.detectEngine()).toBe('docker-desktop');
  });

  it('falls back to "other" for unknown engines', async () => {
    const mod = await loadWithDockerInfoOs('Ubuntu 22.04');
    expect(await mod.detectEngine()).toBe('other');
  });

  it('caches the result across calls', async () => {
    let calls = 0;
    vi.doMock('execa', () => ({
      execa: vi.fn(async () => {
        calls += 1;
        return { stdout: 'OrbStack', stderr: '', exitCode: 0 };
      }),
    }));
    const mod = await import('../src/host-export.js');
    mod.__setEngineForTesting(null);
    await mod.detectEngine();
    await mod.detectEngine();
    await mod.detectEngine();
    expect(calls).toBe(1);
  });
});

describe('getHostPaths', () => {
  let dir: string;
  const originalHome = process.env['HOME'];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentbox-hostpath-test-'));
    process.env['HOME'] = dir;
    vi.resetModules();
  });

  afterEach(async () => {
    vi.resetModules();
    vi.doUnmock('execa');
    process.env['HOME'] = originalHome;
    await rm(dir, { recursive: true, force: true });
  });

  it('derives merged and upper export paths from the box id', async () => {
    vi.doMock('execa', () => ({
      execa: vi.fn(async () => ({ stdout: 'Docker Desktop', stderr: '', exitCode: 0 })),
    }));
    const { getHostPaths, __setEngineForTesting } = await import('../src/host-export.js');
    __setEngineForTesting(null);

    const paths = await getHostPaths({ id: 'abcd1234', upperVolume: 'agentbox-upper-abcd1234' });
    expect(paths.boxDir).toBe(join(dir, '.agentbox', 'boxes', 'abcd1234'));
    expect(paths.mergedExport).toBe(join(dir, '.agentbox', 'boxes', 'abcd1234', 'workspace'));
    expect(paths.upperExport).toBe(join(dir, '.agentbox', 'boxes', 'abcd1234', 'upper'));
    // Docker Desktop: no live host path.
    expect(paths.upperLiveOnHost).toBeNull();
  });

  it('returns the OrbStack live path when ~/OrbStack/docker/volumes/<vol>/upper exists', async () => {
    // Simulate OrbStack's documented shared-folder layout under the fake HOME.
    // Note: OrbStack exposes volume contents *directly* under <vol>/; there's
    // no _data subdir.
    const orbVolDir = join(dir, 'OrbStack', 'docker', 'volumes', 'agentbox-upper-deadbeef');
    await mkdir(join(orbVolDir, 'upper'), { recursive: true });

    vi.doMock('execa', () => ({
      execa: vi.fn(async (_cmd: string, args: readonly string[]) => {
        if (args[0] === 'info') return { stdout: 'OrbStack', stderr: '', exitCode: 0 };
        // We expect resolveUpperLiveOnHost to NOT need to call volume inspect
        // when the OrbStack path already exists, but tolerate the call anyway.
        if (args[0] === 'volume' && args[1] === 'inspect') {
          return { stdout: '/var/lib/docker/volumes/agentbox-upper-deadbeef/_data', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 1 };
      }),
    }));
    const { getHostPaths, __setEngineForTesting } = await import('../src/host-export.js');
    __setEngineForTesting(null);

    const paths = await getHostPaths({ id: 'deadbeef', upperVolume: 'agentbox-upper-deadbeef' });
    expect(paths.upperLiveOnHost).toBe(join(orbVolDir, 'upper'));
  });

  it('falls back to the docker-reported mountpoint when OrbStack path is absent and the mountpoint is a real host path', async () => {
    const customDir = join(dir, 'somewhere', 'else', 'agentbox-upper-cafef00d');
    await mkdir(join(customDir, 'upper'), { recursive: true });

    vi.doMock('execa', () => ({
      execa: vi.fn(async (_cmd: string, args: readonly string[]) => {
        if (args[0] === 'info') return { stdout: 'OrbStack', stderr: '', exitCode: 0 };
        if (args[0] === 'volume' && args[1] === 'inspect') {
          return { stdout: customDir, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 1 };
      }),
    }));
    const { getHostPaths, __setEngineForTesting } = await import('../src/host-export.js');
    __setEngineForTesting(null);

    const paths = await getHostPaths({ id: 'cafef00d', upperVolume: 'agentbox-upper-cafef00d' });
    expect(paths.upperLiveOnHost).toBe(join(customDir, 'upper'));
  });

  it('returns null when no host-side upper path can be found', async () => {
    vi.doMock('execa', () => ({
      execa: vi.fn(async (_cmd: string, args: readonly string[]) => {
        if (args[0] === 'info') return { stdout: 'OrbStack', stderr: '', exitCode: 0 };
        if (args[0] === 'volume' && args[1] === 'inspect') {
          return { stdout: '/var/lib/docker/volumes/nope/_data', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 1 };
      }),
    }));
    const { getHostPaths, __setEngineForTesting } = await import('../src/host-export.js');
    __setEngineForTesting(null);

    const paths = await getHostPaths({ id: 'missing0', upperVolume: 'agentbox-upper-missing0' });
    expect(paths.upperLiveOnHost).toBeNull();
  });
});

describe('pullToHost', () => {
  let dir: string;
  const originalHome = process.env['HOME'];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentbox-pull-test-'));
    process.env['HOME'] = dir;
    vi.resetModules();
  });

  afterEach(async () => {
    vi.resetModules();
    vi.doUnmock('execa');
    process.env['HOME'] = originalHome;
    await rm(dir, { recursive: true, force: true });
  });

  interface Call {
    cmd: string;
    args: string[];
  }

  /**
   * Mock execa dispatching on (cmd, args). `inGit` controls whether the box
   * looks like a git work tree. Records every call for assertions.
   */
  function installExecaMock(opts: { inGit: boolean }): Call[] {
    const calls: Call[] = [];
    vi.doMock('execa', () => ({
      execa: vi.fn(async (cmd: string, args: readonly string[]) => {
        const a = [...args];
        calls.push({ cmd, args: a });
        if (cmd === 'docker' && a[0] === 'info') {
          return { stdout: 'Docker Desktop', stderr: '', exitCode: 0 };
        }
        if (cmd === 'docker' && a[0] === 'exec') {
          if (a.includes('rev-parse')) {
            return opts.inGit
              ? { stdout: 'true', stderr: '', exitCode: 0 }
              : { stdout: '', stderr: 'not a git repository', exitCode: 128 };
          }
          if (a.includes('ls-files')) {
            return { stdout: 'src/a.ts\0src/b.ts\0', stderr: '', exitCode: 0 };
          }
          if (a.includes('find')) {
            return { stdout: 'apps/web/.env\0.env.local\0', stderr: '', exitCode: 0 };
          }
        }
        if (cmd === 'rsync') {
          const isDry = a.includes('--dry-run');
          return {
            stdout: isDry ? '>f+++++++++ src/a.ts\n.d..t...... src/\n' : '',
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    }));
    return calls;
  }

  it('gitignore mode: feeds git ls-files into rsync --files-from -/--from0', async () => {
    const calls = installExecaMock({ inGit: true });
    const { pullToHost, __setEngineForTesting } = await import('../src/host-export.js');
    __setEngineForTesting(null);

    const res = await pullToHost(
      {
        id: 'box1',
        container: 'agentbox-box1',
        upperVolume: 'agentbox-upper-box1',
        workspacePath: join(dir, 'ws'),
      },
      { noRefresh: true },
    );

    expect(res.usedGitignore).toBe(true);
    expect(res.applied).toBe(true);
    expect(res.changes).toEqual(['>f+++++++++ src/a.ts']);

    const lsFiles = calls.find((c) => c.cmd === 'docker' && c.args.includes('ls-files'));
    expect(lsFiles?.args).toContain('-z');
    const rsyncCalls = calls.filter((c) => c.cmd === 'rsync');
    expect(rsyncCalls).toHaveLength(2); // dry-run + real write
    for (const r of rsyncCalls) {
      expect(r.args).toContain('--files-from=-');
      expect(r.args).toContain('--from0');
      expect(r.args).not.toContain('--exclude=node_modules');
      expect(r.args).not.toContain('--delete');
    }
  });

  it('fallback mode (non-git): uses static exclude-list, no git ls-files', async () => {
    const calls = installExecaMock({ inGit: false });
    const { pullToHost, __setEngineForTesting } = await import('../src/host-export.js');
    __setEngineForTesting(null);

    const res = await pullToHost(
      {
        id: 'box2',
        container: 'agentbox-box2',
        upperVolume: 'agentbox-upper-box2',
        workspacePath: join(dir, 'ws'),
      },
      { noRefresh: true },
    );

    expect(res.usedGitignore).toBe(false);
    expect(calls.some((c) => c.args.includes('ls-files'))).toBe(false);
    const rsync = calls.find((c) => c.cmd === 'rsync');
    expect(rsync?.args).toContain('--exclude=.git');
    expect(rsync?.args).toContain('--exclude=node_modules');
    expect(rsync?.args).not.toContain('--files-from=-');
  });

  it('respectGitignore:false forces fallback even in a git box', async () => {
    const calls = installExecaMock({ inGit: true });
    const { pullToHost, __setEngineForTesting } = await import('../src/host-export.js');
    __setEngineForTesting(null);

    const res = await pullToHost(
      {
        id: 'box3',
        container: 'agentbox-box3',
        upperVolume: 'agentbox-upper-box3',
        workspacePath: join(dir, 'ws'),
      },
      { noRefresh: true, respectGitignore: false },
    );

    expect(res.usedGitignore).toBe(false);
    expect(calls.some((c) => c.args.includes('rev-parse'))).toBe(false);
  });

  it('includeNodeModules keeps node_modules in fallback mode', async () => {
    const calls = installExecaMock({ inGit: false });
    const { pullToHost, __setEngineForTesting } = await import('../src/host-export.js');
    __setEngineForTesting(null);

    await pullToHost(
      {
        id: 'box4',
        container: 'agentbox-box4',
        upperVolume: 'agentbox-upper-box4',
        workspacePath: join(dir, 'ws'),
      },
      { noRefresh: true, includeNodeModules: true },
    );

    const rsync = calls.find((c) => c.cmd === 'rsync');
    expect(rsync?.args).toContain('--exclude=.git');
    expect(rsync?.args).not.toContain('--exclude=node_modules');
  });

  it('dryRun does not invoke the real-write rsync', async () => {
    const calls = installExecaMock({ inGit: true });
    const { pullToHost, __setEngineForTesting } = await import('../src/host-export.js');
    __setEngineForTesting(null);

    const res = await pullToHost(
      {
        id: 'box5',
        container: 'agentbox-box5',
        upperVolume: 'agentbox-upper-box5',
        workspacePath: join(dir, 'ws'),
      },
      { noRefresh: true, dryRun: true },
    );

    expect(res.applied).toBe(false);
    const rsyncCalls = calls.filter((c) => c.cmd === 'rsync');
    expect(rsyncCalls).toHaveLength(1);
    expect(rsyncCalls[0]?.args).toContain('--dry-run');
  });

  it('noRefresh:true skips the box->scratch rsync (no docker exec rsync)', async () => {
    const calls = installExecaMock({ inGit: true });
    const { pullToHost, __setEngineForTesting } = await import('../src/host-export.js');
    __setEngineForTesting(null);

    await pullToHost(
      {
        id: 'box6',
        container: 'agentbox-box6',
        upperVolume: 'agentbox-upper-box6',
        workspacePath: join(dir, 'ws'),
      },
      { noRefresh: true },
    );

    // refreshExport would `docker exec ... rsync ... /host-export`; assert no
    // docker-exec call carries an rsync into the container bind.
    const dockerExecRsync = calls.find(
      (c) => c.cmd === 'docker' && c.args[0] === 'exec' && c.args.includes('rsync'),
    );
    expect(dockerExecRsync).toBeUndefined();
  });

  it('env-only mode: find-based selection, gitignore bypassed', async () => {
    const calls = installExecaMock({ inGit: true });
    const { pullToHost, DEFAULT_ENV_PATTERNS, __setEngineForTesting } = await import(
      '../src/host-export.js'
    );
    __setEngineForTesting(null);

    const res = await pullToHost(
      {
        id: 'boxe',
        container: 'agentbox-boxe',
        upperVolume: 'agentbox-upper-boxe',
        workspacePath: join(dir, 'ws'),
      },
      { noRefresh: true, respectGitignore: false, envPatterns: DEFAULT_ENV_PATTERNS },
    );

    expect(res.usedGitignore).toBe(false);
    // respectGitignore:false -> never probes git
    expect(calls.some((c) => c.args.includes('rev-parse'))).toBe(false);
    expect(calls.some((c) => c.args.includes('ls-files'))).toBe(false);

    const find = calls.find((c) => c.cmd === 'docker' && c.args.includes('find'));
    expect(find).toBeDefined();
    expect(find?.args).toContain('/workspace');
    expect(find?.args).toContain('node_modules'); // a pruned dir
    expect(find?.args).toContain('.env'); // a default pattern
    expect(find?.args).toContain('-printf');

    const rsyncCalls = calls.filter((c) => c.cmd === 'rsync');
    for (const r of rsyncCalls) {
      expect(r.args).toContain('--files-from=-');
      expect(r.args).toContain('--from0');
      expect(r.args).toContain('--checksum');
      expect(r.args).not.toContain('--exclude=.git');
      expect(r.args).not.toContain('--delete');
    }
  });

  it('with-env mode: union of git ls-files and find segments', async () => {
    const calls = installExecaMock({ inGit: true });
    const { pullToHost, __setEngineForTesting } = await import('../src/host-export.js');
    __setEngineForTesting(null);

    const res = await pullToHost(
      {
        id: 'boxw',
        container: 'agentbox-boxw',
        upperVolume: 'agentbox-upper-boxw',
        workspacePath: join(dir, 'ws'),
      },
      { noRefresh: true, envPatterns: ['.env'] },
    );

    expect(res.usedGitignore).toBe(true);
    // both segments enumerated
    expect(calls.some((c) => c.args.includes('ls-files'))).toBe(true);
    expect(calls.some((c) => c.args.includes('find'))).toBe(true);

    // rsync --files-from stdin must contain both a git-listed path and an env path
    const { execa } = (await import('execa')) as unknown as {
      execa: { mock: { calls: unknown[][] } };
    };
    const rsyncInvocation = execa.mock.calls.find(
      (c) => c[0] === 'rsync' && Array.isArray(c[1]) && (c[1] as string[]).includes('--files-from=-'),
    );
    const input = (rsyncInvocation?.[2] as { input?: string } | undefined)?.input ?? '';
    const entries = input.split('\0');
    expect(entries).toContain('src/a.ts'); // from git ls-files
    expect(entries).toContain('.env.local'); // from find
    expect(entries).toContain('apps/web/.env'); // from find
  });

  it('with-env mode dedupes overlapping git/env entries', async () => {
    // git ls-files returns src/a.ts,src/b.ts; make find also return src/a.ts.
    const calls: Call[] = [];
    vi.doMock('execa', () => ({
      execa: vi.fn(async (cmd: string, args: readonly string[]) => {
        const a = [...args];
        calls.push({ cmd, args: a });
        if (cmd === 'docker' && a[0] === 'info') {
          return { stdout: 'Docker Desktop', stderr: '', exitCode: 0 };
        }
        if (cmd === 'docker' && a[0] === 'exec') {
          if (a.includes('rev-parse')) return { stdout: 'true', stderr: '', exitCode: 0 };
          if (a.includes('ls-files'))
            return { stdout: 'src/a.ts\0src/b.ts\0', stderr: '', exitCode: 0 };
          if (a.includes('find')) return { stdout: 'src/a.ts\0.env\0', stderr: '', exitCode: 0 };
        }
        if (cmd === 'rsync') return { stdout: '', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    }));
    const { pullToHost, __setEngineForTesting } = await import('../src/host-export.js');
    __setEngineForTesting(null);

    await pullToHost(
      {
        id: 'boxd',
        container: 'agentbox-boxd',
        upperVolume: 'agentbox-upper-boxd',
        workspacePath: join(dir, 'ws'),
      },
      { noRefresh: true, envPatterns: ['.env'] },
    );

    const { execa } = (await import('execa')) as unknown as {
      execa: { mock: { calls: unknown[][] } };
    };
    const rsyncInvocation = execa.mock.calls.find(
      (c) => c[0] === 'rsync' && Array.isArray(c[1]) && (c[1] as string[]).includes('--files-from=-'),
    );
    const input = (rsyncInvocation?.[2] as { input?: string } | undefined)?.input ?? '';
    const entries = input.split('\0');
    expect(entries.filter((e) => e === 'src/a.ts')).toHaveLength(1);
    expect(entries).toContain('.env');
  });
});

describe('buildHostEnvFindArgs', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('roots at "." with -print0 and includes prune dirs + name globs', async () => {
    const { buildHostEnvFindArgs, DEFAULT_ENV_PATTERNS } = await import('../src/host-export.js');
    const argv = buildHostEnvFindArgs(DEFAULT_ENV_PATTERNS);
    expect(argv[0]).toBe('find');
    expect(argv[1]).toBe('.'); // relative root → run with cwd = host workspace
    expect(argv).toContain('node_modules'); // a pruned dir
    expect(argv).toContain('-prune');
    expect(argv).toContain('.env'); // a default pattern
    expect(argv).toContain('agentbox.yaml');
    // macOS BSD find has no -printf; we must use -print0
    expect(argv).toContain('-print0');
    expect(argv).not.toContain('-printf');
    // patterns are OR-joined under the -name group
    expect(argv).toContain('-o');
  });
});

describe('copyHostEnvFilesToBox', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('execa');
  });

  interface Call {
    cmd: string;
    args: string[];
    opts?: { input?: unknown };
  }

  it('pipes find -> tar -> docker exec tar -x and returns the file count', async () => {
    const calls: Call[] = [];
    vi.doMock('execa', () => ({
      execa: vi.fn(async (cmd: string, args: readonly string[], opts?: { input?: unknown }) => {
        const a = [...args];
        calls.push({ cmd, args: a, opts });
        if (cmd === 'find') {
          return { stdout: Buffer.from('./.env\0./apps/web/.env.local\0'), stderr: '', exitCode: 0 };
        }
        if (cmd === 'tar') return { stdout: Buffer.from('TARDATA'), stderr: '', exitCode: 0 };
        if (cmd === 'docker') return { stdout: '', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    }));
    const { copyHostEnvFilesToBox } = await import('../src/host-export.js');

    const res = await copyHostEnvFilesToBox({
      container: 'agentbox-x',
      workspaceDir: '/host/ws',
      patterns: ['.env', '.env.*'],
    });

    expect(res.copied).toBe(2);
    const find = calls.find((c) => c.cmd === 'find');
    expect(find?.cmd).toBe('find');
    const tar = calls.find((c) => c.cmd === 'tar');
    expect(tar?.args).toEqual(['-C', '/host/ws', '--null', '-T', '-', '-cf', '-']);
    const dx = calls.find((c) => c.cmd === 'docker');
    expect(dx?.args).toEqual([
      'exec',
      '-i',
      '--user',
      '1000:1000',
      'agentbox-x',
      'tar',
      '-xf',
      '-',
      '-C',
      '/workspace',
    ]);
  });

  it('returns {copied:0} without throwing when no files match', async () => {
    vi.doMock('execa', () => ({
      execa: vi.fn(async (cmd: string) => {
        if (cmd === 'find') return { stdout: Buffer.from(''), stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    }));
    const { copyHostEnvFilesToBox } = await import('../src/host-export.js');
    const res = await copyHostEnvFilesToBox({
      container: 'agentbox-y',
      workspaceDir: '/host/ws',
      patterns: ['.env'],
    });
    expect(res.copied).toBe(0);
  });

  it('best-effort: a docker exec failure logs and returns {copied:0}, no throw', async () => {
    vi.doMock('execa', () => ({
      execa: vi.fn(async (cmd: string) => {
        if (cmd === 'find') return { stdout: Buffer.from('./.env\0'), stderr: '', exitCode: 0 };
        if (cmd === 'tar') return { stdout: Buffer.from('T'), stderr: '', exitCode: 0 };
        if (cmd === 'docker') return { stdout: '', stderr: 'no such container', exitCode: 1 };
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    }));
    const { copyHostEnvFilesToBox } = await import('../src/host-export.js');
    const logs: string[] = [];
    const res = await copyHostEnvFilesToBox({
      container: 'agentbox-z',
      workspaceDir: '/host/ws',
      patterns: ['.env'],
      onLog: (l) => logs.push(l),
    });
    expect(res.copied).toBe(0);
    expect(logs.some((l) => l.includes('copy into box failed'))).toBe(true);
  });
});

describe('BOXES_ROOT / boxRunDirFor', () => {
  const originalHome = process.env['HOME'];

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
    process.env['HOME'] = originalHome;
  });

  it('roots under $HOME/.agentbox/boxes', async () => {
    process.env['HOME'] = '/tmp/fake-home';
    const { BOXES_ROOT, boxRunDirFor } = await import('../src/host-export.js');
    expect(BOXES_ROOT).toBe('/tmp/fake-home/.agentbox/boxes');
    expect(boxRunDirFor('abcd1234')).toBe('/tmp/fake-home/.agentbox/boxes/abcd1234');
  });
});

