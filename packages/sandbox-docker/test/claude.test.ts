import { describe, expect, it } from 'vitest';
import {
  buildClaudeMounts,
  resolveClaudeVolume,
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

  it('skips empty/missing env values rather than injecting blanks', () => {
    const result = buildClaudeMounts(
      { volume: 'v' },
      { ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: undefined, OTHER_KEY: 'x' },
    );
    expect(result.env).toEqual({});
  });
});
