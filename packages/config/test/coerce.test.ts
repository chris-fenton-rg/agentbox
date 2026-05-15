import { describe, expect, it } from 'vitest';
import { coerceFromString } from '../src/parse.js';
import { UserConfigError } from '../src/types.js';

describe('coerceFromString', () => {
  it('parses booleans (true/yes/1/on)', () => {
    expect(coerceFromString('box.snapshot', 'true')).toBe(true);
    expect(coerceFromString('box.snapshot', 'yes')).toBe(true);
    expect(coerceFromString('box.snapshot', '1')).toBe(true);
    expect(coerceFromString('box.snapshot', 'on')).toBe(true);
    expect(coerceFromString('box.snapshot', 'TRUE')).toBe(true);
  });

  it('parses booleans (false/no/0/off)', () => {
    expect(coerceFromString('box.snapshot', 'false')).toBe(false);
    expect(coerceFromString('box.snapshot', 'no')).toBe(false);
    expect(coerceFromString('box.snapshot', '0')).toBe(false);
    expect(coerceFromString('box.snapshot', 'off')).toBe(false);
  });

  it('rejects non-bool strings for bool keys', () => {
    expect(() => coerceFromString('box.snapshot', 'maybe')).toThrow(UserConfigError);
  });

  it('parses integers', () => {
    expect(coerceFromString('code.timeoutMs', '120000')).toBe(120000);
    expect(coerceFromString('code.timeoutMs', '0')).toBe(0);
    expect(coerceFromString('code.timeoutMs', '-5')).toBe(-5);
  });

  it('rejects non-integers for int keys', () => {
    expect(() => coerceFromString('code.timeoutMs', '120.5')).toThrow(UserConfigError);
    expect(() => coerceFromString('code.timeoutMs', 'abc')).toThrow(UserConfigError);
  });

  it('passes strings through unchanged', () => {
    expect(coerceFromString('box.image', 'agentbox/box:dev')).toBe('agentbox/box:dev');
  });

  it('rejects empty strings for string keys', () => {
    expect(() => coerceFromString('box.image', '')).toThrow(UserConfigError);
  });

  it('accepts valid enum values', () => {
    expect(coerceFromString('engine.kind', 'orbstack')).toBe('orbstack');
    expect(coerceFromString('code.ide', 'cursor')).toBe('cursor');
  });

  it('rejects invalid enum values', () => {
    expect(() => coerceFromString('engine.kind', 'podman')).toThrow(UserConfigError);
    expect(() => coerceFromString('browser.default', 'firefox')).toThrow(UserConfigError);
  });

  it('rejects unknown keys', () => {
    expect(() => coerceFromString('foo.bar', 'baz')).toThrow(UserConfigError);
    expect(() => coerceFromString('flatkey', 'x')).toThrow(UserConfigError);
    expect(() => coerceFromString('box.snorshot', 'true')).toThrow(UserConfigError);
  });
});
