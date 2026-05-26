import { describe, expect, it } from 'vitest';
import { classifyRemoteUrl } from '../src/remote-url.js';

describe('classifyRemoteUrl', () => {
  it('classifies ssh:// URLs', () => {
    expect(classifyRemoteUrl('ssh://user@host/path/to/repo.git')).toBe('ssh');
    expect(classifyRemoteUrl('ssh://git@github.com:22/madarco/agentbox.git')).toBe('ssh');
  });

  it('classifies scp-style SSH with relative path', () => {
    expect(classifyRemoteUrl('git@github.com:madarco/agentbox.git')).toBe('ssh');
    expect(classifyRemoteUrl('user@example.com:project.git')).toBe('ssh');
  });

  it('classifies scp-style SSH with absolute path (regression: PR #4 bugbot LOW)', () => {
    expect(classifyRemoteUrl('git@github.com:/madarco/agentbox.git')).toBe('ssh');
    expect(classifyRemoteUrl('user@host:/abs/path/to/repo.git')).toBe('ssh');
  });

  it('classifies https URLs', () => {
    expect(classifyRemoteUrl('https://github.com/madarco/agentbox.git')).toBe('https');
    expect(classifyRemoteUrl('http://internal.example.com/x.git')).toBe('https');
    expect(classifyRemoteUrl('https://user@github.com/madarco/agentbox.git')).toBe('https');
  });

  it('returns "other" for unsupported schemes', () => {
    expect(classifyRemoteUrl('file:///abs/path/to/repo.git')).toBe('other');
    expect(classifyRemoteUrl('git://github.com/madarco/agentbox.git')).toBe('other');
    expect(classifyRemoteUrl('/local/path/repo.git')).toBe('other');
    expect(classifyRemoteUrl('')).toBe('other');
  });
});
