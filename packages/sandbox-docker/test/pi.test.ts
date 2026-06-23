import { describe, expect, it } from 'vitest';
import {
  buildPiAttachArgv,
  buildPiMounts,
  DEFAULT_PI_SESSION,
  resolvePiVolume,
  SHARED_PI_VOLUME,
} from '../src/pi.js';

describe('resolvePiVolume', () => {
  it('returns the shared volume name when isolate is false', () => {
    expect(resolvePiVolume({ isolate: false, boxId: 'aabbccdd' })).toEqual({
      volume: SHARED_PI_VOLUME,
    });
  });

  it('returns a per-box volume name when isolate is true', () => {
    expect(resolvePiVolume({ isolate: true, boxId: 'aabbccdd' })).toEqual({
      volume: `${SHARED_PI_VOLUME}-aabbccdd`,
    });
  });
});

describe('buildPiMounts', () => {
  it('mounts the volume at ~/.pi and pins PI_CODING_AGENT_DIR to the agent subdir', () => {
    const result = buildPiMounts({ volume: 'my-vol' }, {});
    expect(result.extraVolumes).toEqual(['my-vol:/home/vscode/.pi']);
    expect(result.volumeName).toBe('my-vol');
    expect(result.env['PI_CODING_AGENT_DIR']).toBe('/home/vscode/.pi/agent');
  });

  it('forwards provider API keys (incl. GLM) when set on the host', () => {
    const result = buildPiMounts(
      { volume: 'v' },
      { ANTHROPIC_API_KEY: 'sk-ant', ZAI_GLM_API_KEY: 'glm-key' },
    );
    expect(result.env['ANTHROPIC_API_KEY']).toBe('sk-ant');
    expect(result.env['ZAI_GLM_API_KEY']).toBe('glm-key');
  });

  it('skips empty/missing provider keys but always sets PI_CODING_AGENT_DIR', () => {
    const result = buildPiMounts(
      { volume: 'v' },
      { ANTHROPIC_API_KEY: '', OPENROUTER_API_KEY: undefined, OTHER_KEY: 'x' },
    );
    expect(result.env).toEqual({
      PI_CODING_AGENT_DIR: '/home/vscode/.pi/agent',
    });
  });
});

describe('buildPiAttachArgv', () => {
  it('attaches to the default pi tmux session', () => {
    const argv = buildPiAttachArgv('agentbox-box1');
    expect(argv.slice(0, 2)).toEqual(['exec', '-it']);
    expect(argv).toContain('agentbox-box1');
    expect(argv.slice(-4)).toEqual(['tmux', 'attach', '-t', DEFAULT_PI_SESSION]);
  });

  it('attaches to a custom session name', () => {
    const argv = buildPiAttachArgv('agentbox-box1', 'my-pi');
    expect(argv.slice(-4)).toEqual(['tmux', 'attach', '-t', 'my-pi']);
  });
});
