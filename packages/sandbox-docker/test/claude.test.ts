import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildClaudeDashboardAttachArgv,
  buildClaudeMounts,
  buildClaudeStatusBarArgs,
  formatDetachNotice,
  DEFAULT_CLAUDE_SESSION,
  resolveClaudeVolume,
  scanPluginCacheForRebuild,
  SHARED_CLAUDE_VOLUME,
} from '../src/claude.js';

describe('resolveClaudeVolume', () => {
  it('returns the shared volume name when isolate is false', () => {
    expect(resolveClaudeVolume({ isolate: false, boxId: 'aabbccdd' })).toEqual({
      volume: SHARED_CLAUDE_VOLUME,
    });
  });

  it('returns a per-box volume name when isolate is true', () => {
    expect(resolveClaudeVolume({ isolate: true, boxId: 'aabbccdd' })).toEqual({
      volume: `${SHARED_CLAUDE_VOLUME}-aabbccdd`,
    });
  });
});

describe('buildClaudeDashboardAttachArgv', () => {
  it('attaches via a grouped sibling session with the inner status bar off', () => {
    const argv = buildClaudeDashboardAttachArgv('agentbox-box1');
    const dash = `${DEFAULT_CLAUDE_SESSION}-dash`;
    // grouped session created (or no-op) before status is changed, attach last
    expect(argv).toEqual([
      'exec',
      '-it',
      '-e',
      `TERM=${process.env['TERM'] ?? 'xterm-256color'}`,
      '--user',
      'vscode',
      'agentbox-box1',
      'tmux',
      'new-session',
      '-A',
      '-d',
      '-s',
      dash,
      '-t',
      DEFAULT_CLAUDE_SESSION,
      ';',
      'set',
      '-t',
      dash,
      'status',
      'off',
      ';',
      'attach',
      '-t',
      dash,
    ]);
  });

  it('derives the grouped session from a custom session name', () => {
    const argv = buildClaudeDashboardAttachArgv('agentbox-box1', 'codex');
    expect(argv).toContain('codex');
    expect(argv).toContain('codex-dash');
    // never attaches directly to the original session (would show its footer)
    const attachIdx = argv.lastIndexOf('attach');
    expect(argv[attachIdx + 2]).toBe('codex-dash');
  });
});

describe('formatDetachNotice', () => {
  it('tells the user how to reattach by numeric index', () => {
    expect(formatDetachNotice('3')).toBe(
      'Session detached. Reattach with: agentbox claude attach 3',
    );
  });
  it('falls back to a box name ref', () => {
    expect(formatDetachNotice('my-box')).toBe(
      'Session detached. Reattach with: agentbox claude attach my-box',
    );
  });
});

describe('buildClaudeStatusBarArgs', () => {
  it('styles the named session with box name + detach hint, no window clutter', () => {
    const args = buildClaudeStatusBarArgs(DEFAULT_CLAUDE_SESSION, 'my-box');

    // tmux command separators present and each `set` is scoped to the session
    expect(args.filter((a) => a === ';').length).toBeGreaterThanOrEqual(9);
    const setIdxs = args.flatMap((a, i) => (a === 'set' ? [i] : []));
    expect(setIdxs.length).toBeGreaterThan(0);
    for (const i of setIdxs) {
      expect(args[i + 1]).toBe('-t');
      expect(args[i + 2]).toBe(DEFAULT_CLAUDE_SESSION);
    }

    // status-left shows the literal box name (no shell/strftime indirection)
    const leftIdx = args.indexOf('status-left');
    expect(leftIdx).toBeGreaterThan(-1);
    const left = args[leftIdx + 1];
    expect(left).toContain('agentbox ▸ my-box');
    expect(left).not.toContain('#(');
    expect(left).not.toContain('%');

    // status-right is the detach hint
    const rightIdx = args.indexOf('status-right');
    expect(args[rightIdx + 1]).toContain('Ctrl-b d detach');

    // the noisy window list is emptied
    expect(args).toContain('window-status-format');
    expect(args).toContain('window-status-current-format');
    expect(args[args.indexOf('window-status-current-format') + 1]).toBe('');
  });

  it('scopes options to a custom session name', () => {
    const args = buildClaudeStatusBarArgs('codex', 'my-box');
    for (const i of args.flatMap((a, idx) => (a === 'set' ? [idx] : []))) {
      expect(args[i + 2]).toBe('codex');
    }
  });
});

describe('buildClaudeMounts', () => {
  it('mounts the resolved volume at /home/vscode/.claude', () => {
    const result = buildClaudeMounts({ volume: 'my-vol' }, {});
    expect(result.extraVolumes).toEqual(['my-vol:/home/vscode/.claude']);
    expect(result.volumeName).toBe('my-vol');
  });

  it('forwards ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN when set', () => {
    const result = buildClaudeMounts(
      { volume: 'v' },
      { ANTHROPIC_API_KEY: 'sk-test', CLAUDE_CODE_OAUTH_TOKEN: 'oat-1' },
    );
    expect(result.env).toEqual({
      ANTHROPIC_API_KEY: 'sk-test',
      CLAUDE_CODE_OAUTH_TOKEN: 'oat-1',
    });
  });

  it('forwards CLAUDE_EFFORT and ANTHROPIC_MODEL when set', () => {
    const result = buildClaudeMounts(
      { volume: 'v' },
      { CLAUDE_EFFORT: 'xhigh', ANTHROPIC_MODEL: 'claude-opus-4-7' },
    );
    expect(result.env).toEqual({
      CLAUDE_EFFORT: 'xhigh',
      ANTHROPIC_MODEL: 'claude-opus-4-7',
    });
  });

  it('skips empty/missing env values rather than injecting blanks', () => {
    const result = buildClaudeMounts(
      { volume: 'v' },
      {
        ANTHROPIC_API_KEY: '',
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
        CLAUDE_EFFORT: '',
        ANTHROPIC_MODEL: undefined,
        OTHER_KEY: 'x',
      },
    );
    expect(result.env).toEqual({});
  });
});

describe('scanPluginCacheForRebuild', () => {
  let root: string;
  const versionDir = (m: string, p: string, v: string) =>
    join(root, m, p, v);
  const seed = async (m: string, p: string, v: string, files: string[]) => {
    const d = versionDir(m, p, v);
    await mkdir(d, { recursive: true });
    for (const f of files) await writeFile(join(d, f), '{}');
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agentbox-cache-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns false when the cache root does not exist', async () => {
    expect(await scanPluginCacheForRebuild(join(root, 'nope'))).toBe(false);
  });

  it('returns false when every package.json plugin has the install marker', async () => {
    await seed('mkt', 'plug', '1.0.0', ['package.json', '.agentbox-installed']);
    expect(await scanPluginCacheForRebuild(root)).toBe(false);
  });

  it('returns true when a package.json plugin is missing the marker', async () => {
    await seed('mkt', 'a', '1.0.0', ['package.json', '.agentbox-installed']);
    await seed('mkt', 'b', '2.1.0', ['package.json']);
    expect(await scanPluginCacheForRebuild(root)).toBe(true);
  });

  it('ignores skill-only plugins that ship no package.json', async () => {
    await seed('mkt', 'skill-only', 'unknown', ['SKILL.md']);
    expect(await scanPluginCacheForRebuild(root)).toBe(false);
  });

  it('skips a plugin with a recent install-failure marker (backoff)', async () => {
    await seed('mkt', 'flaky', '1.0.0', ['package.json', '.agentbox-install-failed']);
    expect(await scanPluginCacheForRebuild(root)).toBe(false);
  });

  it('retries a plugin whose failure marker has aged past the backoff window', async () => {
    await seed('mkt', 'flaky', '1.0.0', ['package.json', '.agentbox-install-failed']);
    const stale = new Date(Date.now() - 7 * 60 * 60 * 1000); // > 6h backoff
    await utimes(versionDir('mkt', 'flaky', '1.0.0') + '/.agentbox-install-failed', stale, stale);
    expect(await scanPluginCacheForRebuild(root)).toBe(true);
  });
});
