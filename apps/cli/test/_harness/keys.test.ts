import { describe, expect, it } from 'vitest';
import { parseKeys } from './keys.js';

describe('parseKeys', () => {
  it('passes literal text through', () => {
    expect(parseKeys('hello world')).toBe('hello world');
  });

  it('expands named keys', () => {
    expect(parseKeys('<Enter>')).toBe('\r');
    expect(parseKeys('<Tab>')).toBe('\t');
    expect(parseKeys('<Esc>')).toBe('\x1b');
    expect(parseKeys('<Space>')).toBe(' ');
    expect(parseKeys('<BS>')).toBe('\x7f');
  });

  it('is case-insensitive on tokens', () => {
    expect(parseKeys('<ENTER>')).toBe('\r');
    expect(parseKeys('<enter>')).toBe('\r');
    expect(parseKeys('<Enter>')).toBe('\r');
  });

  it('expands C-x as control bytes', () => {
    expect(parseKeys('<C-a>')).toBe('\x01');
    expect(parseKeys('<C-c>')).toBe('\x03');
    expect(parseKeys('<C-z>')).toBe('\x1a');
  });

  it('expands arrow keys', () => {
    expect(parseKeys('<Up>')).toBe('\x1b[A');
    expect(parseKeys('<Down>')).toBe('\x1b[B');
    expect(parseKeys('<Right>')).toBe('\x1b[C');
    expect(parseKeys('<Left>')).toBe('\x1b[D');
  });

  it('expands function keys', () => {
    expect(parseKeys('<F1>')).toBe('\x1bOP');
    expect(parseKeys('<F5>')).toBe('\x1b[15~');
    expect(parseKeys('<F12>')).toBe('\x1b[24~');
  });

  it('concatenates literal text with tokens', () => {
    expect(parseKeys('ls<Enter>')).toBe('ls\r');
    expect(parseKeys('<C-a>q')).toBe('\x01q');
    expect(parseKeys('what is 2+2?<Enter>')).toBe('what is 2+2?\r');
  });

  it('treats `<<` as literal `<`', () => {
    // `<<` escapes one `<`; the rest is parsed normally.
    expect(parseKeys('a <<Enter> b')).toBe('a <Enter> b');
    expect(parseKeys('<<<C-a>')).toBe('<\x01');
  });

  it('surfaces unknown tokens verbatim', () => {
    expect(parseKeys('<Banana>')).toBe('<Banana>');
  });

  it('treats unterminated `<` as a literal', () => {
    expect(parseKeys('a < b')).toBe('a < b');
  });
});
