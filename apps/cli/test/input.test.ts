import { describe, expect, it } from 'vitest';
import { InputParser, type InputEvent } from '../src/dashboard/input.js';

function harness(transform?: (x: number, y: number) => { x: number; y: number } | null) {
  const events: InputEvent[] = [];
  const timers: Array<{ id: number; fn: () => void }> = [];
  let seq = 0;
  const parser = new InputParser({
    onEvent: (e) => events.push(e),
    mouseTransform: transform,
    setTimer: (_ms, fn) => {
      const id = ++seq;
      timers.push({ id, fn });
      return id;
    },
    clearTimer: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const fire = (): void => {
    const cur = timers.splice(0, timers.length);
    for (const t of cur) t.fn();
  };
  const fwd = (): string =>
    events
      .filter((e) => e.type === 'forward')
      .map((e) => (e.type === 'forward' ? e.bytes.toString('latin1') : ''))
      .join('');
  return { parser, events, fire, fwd };
}

describe('InputParser keymap', () => {
  it('Ctrl+Option+Up/Down (CSI 1;7 A/B) switches', () => {
    const h = harness();
    h.parser.feed(Buffer.from('\x1b[1;7A'));
    h.parser.feed(Buffer.from('\x1b[1;7B'));
    expect(h.events).toEqual([
      { type: 'switch', dir: 'prev' },
      { type: 'switch', dir: 'next' },
    ]);
  });

  it('Ctrl-a leader: v/c/w → actions, q → quit, k/j → switch', () => {
    const h = harness();
    h.parser.feed(Buffer.from([0x01, 0x76])); // ^A v
    h.parser.feed(Buffer.from([0x01, 0x63])); // ^A c
    h.parser.feed(Buffer.from([0x01, 0x77])); // ^A w
    h.parser.feed(Buffer.from([0x01, 0x71])); // ^A q
    h.parser.feed(Buffer.from([0x01, 0x6b])); // ^A k
    h.parser.feed(Buffer.from([0x01, 0x6a])); // ^A j
    expect(h.events).toEqual([
      { type: 'action', name: 'vnc' },
      { type: 'action', name: 'code' },
      { type: 'action', name: 'web' },
      { type: 'quit' },
      { type: 'switch', dir: 'prev' },
      { type: 'switch', dir: 'next' },
    ]);
  });

  it('double Ctrl-a sends one literal Ctrl-a; lone Ctrl-a flushes on timeout', () => {
    const h = harness();
    h.parser.feed(Buffer.from([0x01, 0x01]));
    expect(h.fwd()).toBe('\x01');
    const h2 = harness();
    h2.parser.feed(Buffer.from([0x01]));
    expect(h2.fwd()).toBe('');
    h2.fire();
    expect(h2.fwd()).toBe('\x01');
  });

  it('unrecognized leader key: leader consumed, key forwarded', () => {
    const h = harness();
    h.parser.feed(Buffer.from([0x01, 0x7a])); // ^A z
    expect(h.fwd()).toBe('z');
    expect(h.events.some((e) => e.type !== 'forward')).toBe(false);
  });

  it('forwards a plain arrow key verbatim (not a chord)', () => {
    const h = harness();
    h.parser.feed(Buffer.from('\x1b[A'));
    expect(h.fwd()).toBe('\x1b[A');
    expect(h.events.some((e) => e.type !== 'forward')).toBe(false);
  });

  it('forwards a lone ESC after the inter-byte timeout', () => {
    const h = harness();
    h.parser.feed(Buffer.from([0x1b]));
    expect(h.fwd()).toBe('');
    h.fire();
    expect(h.fwd()).toBe('\x1b');
  });

  it('forwards an unrecognized CSI verbatim', () => {
    const h = harness();
    h.parser.feed(Buffer.from('\x1b[3~')); // Delete
    expect(h.fwd()).toBe('\x1b[3~');
  });
});

describe('InputParser mouse', () => {
  it('translates an SGR wheel report into pane-local coords', () => {
    const h = harness((x, y) => ({ x: x - 33, y }));
    h.parser.feed(Buffer.from('\x1b[<64;50;10M', 'latin1'));
    expect(h.fwd()).toBe('\x1b[<64;17;10M');
  });

  it('drops a mouse report over the sidebar (transform → null)', () => {
    const h = harness(() => null);
    h.parser.feed(Buffer.from('\x1b[<0;5;3M', 'latin1'));
    expect(h.fwd()).toBe('');
  });

  it('forwards SGR mouse verbatim when no transform is set', () => {
    const h = harness(undefined);
    h.parser.feed(Buffer.from('\x1b[<0;12;7m', 'latin1'));
    expect(h.fwd()).toBe('\x1b[<0;12;7m');
  });

  it('translates a legacy X10 mouse report', () => {
    const h = harness((x, y) => ({ x: x - 10, y: y - 1 }));
    const seq = Buffer.from([0x1b, 0x5b, 0x4d, 32, 32 + 50, 32 + 10]);
    h.parser.feed(seq);
    expect(Buffer.from(h.fwd(), 'latin1')).toEqual(
      Buffer.from([0x1b, 0x5b, 0x4d, 32, 32 + 40, 32 + 9]),
    );
  });
});
