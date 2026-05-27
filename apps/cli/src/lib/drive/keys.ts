// Translate a small keystroke DSL into the bytes a terminal expects.
// Literal text passes through as-is; `<...>` tokens map to control bytes
// or xterm escape sequences. Tokens are case-insensitive.
//
//   <Enter> <Tab> <Esc> <Space> <BS> <Del>
//   <C-x>           Ctrl+x for any letter a-z (0x01..0x1a)
//   <Up|Down|Left|Right>
//   <Home|End|PageUp|PageDown>
//   <F1>..<F12>
//
// Use `<` literally by escaping as `<<`.

const NAMED: Record<string, string> = {
  enter: '\r',
  return: '\r',
  tab: '\t',
  esc: '\x1b',
  escape: '\x1b',
  space: ' ',
  bs: '\x7f',
  backspace: '\x7f',
  del: '\x1b[3~',
  delete: '\x1b[3~',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
  f1: '\x1bOP',
  f2: '\x1bOQ',
  f3: '\x1bOR',
  f4: '\x1bOS',
  f5: '\x1b[15~',
  f6: '\x1b[17~',
  f7: '\x1b[18~',
  f8: '\x1b[19~',
  f9: '\x1b[20~',
  f10: '\x1b[21~',
  f11: '\x1b[23~',
  f12: '\x1b[24~',
};

export function parseKeys(input: string): string {
  let out = '';
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '<') {
      if (input[i + 1] === '<') {
        out += '<';
        i += 2;
        continue;
      }
      const close = input.indexOf('>', i + 1);
      if (close === -1) {
        out += ch;
        i += 1;
        continue;
      }
      const tok = input.slice(i + 1, close);
      out += resolveToken(tok);
      i = close + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// Concatenate-and-parse: lets callers pass multiple shell args without
// the shell sneaking in spaces between them. `["ls", "<Enter>"] -> "ls\r"`.
export function parseKeysList(input: string[]): string {
  return parseKeys(input.join(''));
}

function resolveToken(raw: string): string {
  const tok = raw.trim().toLowerCase();
  if (NAMED[tok] !== undefined) return NAMED[tok];
  const ctl = /^c-([a-z])$/.exec(tok);
  if (ctl && ctl[1]) {
    const code = ctl[1].charCodeAt(0) - 'a'.charCodeAt(0) + 1;
    return String.fromCharCode(code);
  }
  return `<${raw}>`;
}
