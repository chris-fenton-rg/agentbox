import { describe, expect, it } from 'vitest';
import { parseKeys, parseKeysList } from '../src/lib/drive/keys.js';

describe('parseKeys (drive lib)', () => {
  it('passes literal text through', () => {
    expect(parseKeys('hello world')).toBe('hello world');
  });

  it('expands C-x as control bytes', () => {
    expect(parseKeys('<C-a>')).toBe('\x01');
    expect(parseKeys('<C-c>')).toBe('\x03');
    expect(parseKeys('<C-z>')).toBe('\x1a');
  });

  it('concatenates literal text with tokens', () => {
    expect(parseKeys('ls<Enter>')).toBe('ls\r');
    expect(parseKeys('<C-a>q')).toBe('\x01q');
  });

  it('treats `<<` as literal `<`', () => {
    expect(parseKeys('a <<Enter> b')).toBe('a <Enter> b');
  });

  it('surfaces unknown tokens verbatim so typos are visible', () => {
    expect(parseKeys('<Banana>')).toBe('<Banana>');
  });
});

describe('parseKeysList', () => {
  it('concatenates argv without injecting spaces', () => {
    expect(parseKeysList(['ls', '<Enter>'])).toBe('ls\r');
    expect(parseKeysList(['what is 2+2?', '<Enter>'])).toBe('what is 2+2?\r');
  });

  it('treats an empty list as empty output', () => {
    expect(parseKeysList([])).toBe('');
  });

  it('still parses tokens that span across multiple shell args (concat first)', () => {
    expect(parseKeysList(['<C-', 'a>'])).toBe('\x01');
  });
});
