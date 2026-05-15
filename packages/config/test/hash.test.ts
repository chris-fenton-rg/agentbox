import { describe, expect, it } from 'vitest';
import { hashProjectPath } from '../src/paths.js';

describe('hashProjectPath', () => {
  it('returns 16 lowercase hex chars', () => {
    const h = hashProjectPath('/Users/marco/Projects/AgentBox/agentbox');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is stable across calls', () => {
    const h1 = hashProjectPath('/foo/bar');
    const h2 = hashProjectPath('/foo/bar');
    expect(h1).toBe(h2);
  });

  it('treats a single trailing slash as identical', () => {
    expect(hashProjectPath('/foo/bar/')).toBe(hashProjectPath('/foo/bar'));
  });

  it('does not collapse the root "/"', () => {
    // "/" should not become "" — would collide with empty paths.
    expect(hashProjectPath('/')).toBe(hashProjectPath('/'));
    expect(hashProjectPath('/')).not.toBe(hashProjectPath(''));
  });

  it('is case-sensitive (APFS preserves case)', () => {
    expect(hashProjectPath('/foo/Bar')).not.toBe(hashProjectPath('/foo/bar'));
  });

  it('different paths produce different hashes', () => {
    expect(hashProjectPath('/foo/bar')).not.toBe(hashProjectPath('/foo/baz'));
  });
});
