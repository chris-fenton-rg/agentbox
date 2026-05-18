export interface SidebarBox {
  id: string;
  name: string;
  /** Container state: 'running' | 'paused' | 'stopped' | 'missing' | … */
  state: string;
  /** 'working' | 'idle' | 'waiting' | 'unknown' | undefined */
  claudeActivity?: string;
}

export function activityCell(b: SidebarBox): string {
  if (b.state !== 'running') return `[${b.state}]`;
  switch (b.claudeActivity) {
    case 'working':
      return '● working';
    case 'idle':
      return '○ idle';
    case 'waiting':
      return '◐ waiting';
    default:
      return '? unknown';
  }
}

/** Synthetic sidebar entry pinned at the top: selecting it opens the create
 *  menu. Carried in the compositor's box list like a real box (sentinel id),
 *  so selection/switch/highlight need no special-casing. */
export const NEW_BOX_ID = '__agentbox_new__';
export const NEW_BOX_LABEL = '+ New box';

/** Sidebar banner text (centered + styled by the compositor). */
export const SIDEBAR_HEADER = '═ AgentBox ═';
/** Lines `sidebarLines` reserves before the box rows (banner + blank). The
 *  compositor uses this to locate the selected box row for highlighting. */
export const SIDEBAR_HEADER_LINES = 2;

function fit(s: string, w: number): string {
  if (s.length === w) return s;
  if (s.length > w) return s.slice(0, w);
  return s + ' '.repeat(w - s.length);
}

/** `s` centered in a field of `w` columns (truncated if it doesn't fit). */
function center(s: string, w: number): string {
  if (s.length >= w) return s.slice(0, w);
  const pad = w - s.length;
  const leftPad = Math.floor(pad / 2);
  return ' '.repeat(leftPad) + s + ' '.repeat(pad - leftPad);
}

/**
 * The sidebar region as exactly `h` lines, each exactly `w` columns. Pure —
 * no ANSI positioning (the compositor places it).
 */
export function sidebarLines(
  boxes: SidebarBox[],
  selectedId: string,
  w: number,
  h: number,
): string[] {
  const lines: string[] = [center(SIDEBAR_HEADER, w), fit('', w)];
  const nameW = Math.min(16, Math.max(6, ...boxes.map((b) => b.name.length), 6));
  for (const b of boxes) {
    const marker = b.id === selectedId ? '▸ ' : '  ';
    const row =
      b.id === NEW_BOX_ID
        ? `${marker}${NEW_BOX_LABEL}`
        : `${marker}${fit(b.name, nameW)}  ${activityCell(b)}`;
    lines.push(fit(row, w));
  }
  if (boxes.length === 0) lines.push(fit(' (no boxes)', w));
  while (lines.length < h) lines.push(fit('', w));
  return lines.slice(0, h);
}

/**
 * Centered action menu for a running box with no Claude session.
 * Exactly `h` lines, each exactly `w` columns. Pure.
 */
export function menuLines(boxName: string, w: number, h: number): string[] {
  const body = [
    '',
    `  No Claude session in ${boxName}.`,
    '',
    '   [c]  Start Claude here',
    '   [s]  Open a shell',
    '',
    '  Ctrl+Option+↑/↓ switch · Ctrl-a then v/c/w/q (vnc/code/web/quit)',
  ];
  const top = Math.max(0, Math.floor((h - body.length) / 2));
  const out: string[] = [];
  for (let i = 0; i < h; i++) out.push(fit(body[i - top] ?? '', w));
  return out;
}

/**
 * Centered action menu for a non-running box (paused/stopped): resume +
 * destroy, with a two-step destroy confirm (the TUI can't show a prompt).
 * Exactly `h` lines, each exactly `w` columns. Pure.
 */
export function lifecycleMenuLines(
  boxName: string,
  state: 'paused' | 'stopped',
  confirmDestroy: boolean,
  w: number,
  h: number,
): string[] {
  const body = confirmDestroy
    ? [
        '',
        `  Destroy ${boxName}?`,
        '  This removes the container and its volumes.',
        '',
        '   [y]  Yes, destroy',
        '   [any other key]  Cancel',
      ]
    : [
        '',
        `  Box ${boxName} is ${state}.`,
        '',
        state === 'paused' ? '   [u]  Unpause' : '   [s]  Start',
        '   [d]  Destroy',
        '',
        '  Ctrl+Option+↑/↓ switch · Ctrl-a then q quit',
      ];
  const top = Math.max(0, Math.floor((h - body.length) / 2));
  const out: string[] = [];
  for (let i = 0; i < h; i++) out.push(fit(body[i - top] ?? '', w));
  return out;
}

/**
 * Centered menu for the synthetic "+ New box" entry. Exactly `h` lines, each
 * exactly `w` columns. Pure.
 */
export function createMenuLines(where: string, w: number, h: number): string[] {
  const body = [
    '',
    '  Create a new box',
    '',
    '   [c]  Create + launch Claude',
    '   [n]  Create only',
    '',
    `  in ${where}`,
    '',
    '  Ctrl+Option+↑/↓ switch · Ctrl-a then q quit',
  ];
  const top = Math.max(0, Math.floor((h - body.length) / 2));
  const out: string[] = [];
  for (let i = 0; i < h; i++) out.push(fit(body[i - top] ?? '', w));
  return out;
}

// Status-bar palette — matches the in-box tmux footer
// (`buildClaudeStatusBarArgs`): dark bar, blue brand block, dim-grey hints
// with white key chords.
/** The footer/sidebar background gray. Truecolor (not palette index 236) so
 *  it pins an exact RGB — terminals can remap/shade indexed colors per
 *  context, which made the sidebar and status bar look like different grays.
 *  Single source so the two regions can't drift. */
export const BAR_BG = '\x1b[48;2;48;48;48m';
const BAR_BASE = BAR_BG + '\x1b[38;5;250m';
const BAR_BRAND = '\x1b[48;5;39m\x1b[38;5;16m'; // blue block (not bold)
const BRAND_BOLD = '\x1b[1m'; // box name only
const BRAND_NOBOLD = '\x1b[22m';
const HINT_KEY = '\x1b[38;5;255m'; // white: the key chord
const HINT_TXT = '\x1b[38;5;245m'; // gray: labels + separators
const BAR_RESET = '\x1b[0m';

// [key chord, label]. Keys spelled out (no ⌥/^ glyphs). Rendered as
// `KEYS: label` with the chord white and the label gray.
const HINT_GROUPS: ReadonlyArray<readonly [string, string]> = [
  ['Control+Option+Up/Down', 'switch'],
  ['Control+a c', 'code'],
  ['Control+a v', 'vnc'],
  ['Control+a w', 'web'],
  ['Control+a q', 'quit'],
];

/**
 * Status line, exactly `w` printable columns, colored to match the in-box tmux
 * footer (dark bar, blue ` agentbox ▸ … ` brand block on the left, dim-grey
 * shortcut hints on the right). `stateLabel` overrides the box's activity text
 * (used for `shell` / `menu` panes where claudeActivity would otherwise show a
 * misleading `unknown`).
 */
export function statusLine(
  box: SidebarBox | undefined,
  w: number,
  stateLabel?: string,
): string {
  const state =
    stateLabel ?? (box ? (box.state === 'running' ? (box.claudeActivity ?? 'unknown') : box.state) : '');
  // "agentbox ▸ " stays normal weight; only the box name + state are bold.
  const brandPrefix = box ? ' agentbox ▸ ' : ' agentbox ';
  const brandMain = box ? `${box.name} (${state}) ` : '';
  const left = brandPrefix + brandMain;
  const leftStyled =
    BAR_BRAND + brandPrefix + BRAND_BOLD + brandMain + BRAND_NOBOLD;
  // Plain (uncolored) form for width math; styled form for output.
  const SEP = '   │   ';
  const rightPlain =
    HINT_GROUPS.map(([k, l]) => `${k}: ${l}`).join(SEP) + ' ';
  const rightStyled =
    HINT_GROUPS.map(([k, l]) => `${HINT_KEY}${k}${HINT_TXT}: ${l}`).join(
      `${HINT_TXT}${SEP}`,
    ) + ' ';
  if (left.length + rightPlain.length + 1 > w) {
    // Too narrow for the hints — just the brand block (normal weight),
    // padded to width.
    return BAR_BASE + BAR_BRAND + fit(left, w) + BAR_RESET;
  }
  const gap = w - left.length - rightPlain.length;
  // brand block (name bold) → base bar → gap → white/gray hints.
  return (
    BAR_BASE +
    leftStyled +
    BAR_BASE +
    ' '.repeat(gap) +
    rightStyled +
    BAR_RESET
  );
}
