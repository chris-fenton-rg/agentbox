import { describe, expect, it } from 'vitest';
import { parseEnvFile } from '../src/env-loader.js';

describe('parseEnvFile', () => {
  it('handles bare KEY=value', () => {
    expect(parseEnvFile('E2B_API_KEY=abc')).toEqual({ E2B_API_KEY: 'abc' });
  });

  it('handles double-quoted, single-quoted, and `export`-prefixed forms', () => {
    const body = ['E2B_API_KEY="quoted"', "E2B_DOMAIN='single'", 'export FOO=bar'].join('\n');
    expect(parseEnvFile(body)).toEqual({
      E2B_API_KEY: 'quoted',
      E2B_DOMAIN: 'single',
      FOO: 'bar',
    });
  });

  it('skips blank lines and comments', () => {
    const body = ['', '# header', 'E2B_API_KEY=abc', '#trailing', ''].join('\n');
    expect(parseEnvFile(body)).toEqual({ E2B_API_KEY: 'abc' });
  });

  it('ignores malformed lines (no = sign)', () => {
    expect(parseEnvFile('no_equals_here\nE2B_API_KEY=abc')).toEqual({ E2B_API_KEY: 'abc' });
  });

  it('preserves = signs inside values', () => {
    expect(parseEnvFile('E2B_API_KEY=ab=cd=ef')).toEqual({ E2B_API_KEY: 'ab=cd=ef' });
  });
});
