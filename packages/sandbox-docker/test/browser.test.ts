import { describe, expect, it } from 'vitest';
import { browserSessionActive } from '../src/browser.js';

describe('browserSessionActive', () => {
  it('is false when agent-browser reports no active sessions', () => {
    expect(browserSessionActive('No active sessions\n', 0)).toBe(false);
  });

  it('is case-insensitive on the no-sessions sentinel', () => {
    expect(browserSessionActive('no active sessions', 0)).toBe(false);
  });

  it('is true when a session is listed on a clean exit', () => {
    expect(browserSessionActive('default  about:blank  (running)\n', 0)).toBe(true);
  });

  it('is false on a non-zero exit even if stdout looks like a session list', () => {
    expect(browserSessionActive('default  about:blank', 1)).toBe(false);
  });

  it('is false on an empty stdout with a non-zero exit', () => {
    expect(browserSessionActive('', -1)).toBe(false);
  });
});
