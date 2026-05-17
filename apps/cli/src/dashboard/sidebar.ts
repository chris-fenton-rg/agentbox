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

function fit(s: string, w: number): string {
  if (s.length === w) return s;
  if (s.length > w) return s.slice(0, w);
  return s + ' '.repeat(w - s.length);
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
  const lines: string[] = [fit(' BOXES', w), fit('', w)];
  const nameW = Math.min(16, Math.max(6, ...boxes.map((b) => b.name.length), 6));
  for (const b of boxes) {
    const marker = b.id === selectedId ? '▸ ' : '  ';
    lines.push(fit(`${marker}${fit(b.name, nameW)}  ${activityCell(b)}`, w));
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
 * Inverse-video status line, exactly `w` columns. `stateLabel` overrides the
 * box's activity text (used for `shell` / `menu` panes where claudeActivity
 * would otherwise show a misleading `unknown`).
 */
export function statusLine(
  box: SidebarBox | undefined,
  w: number,
  stateLabel?: string,
): string {
  const state =
    stateLabel ?? (box ? (box.state === 'running' ? (box.claudeActivity ?? 'unknown') : box.state) : '');
  const left = box ? ` agentbox ▸ ${box.name} (${state})` : ' agentbox';
  const right = '^⌥↑↓ switch · ^a v vnc · ^a c code · ^a w web · ^a q quit ';
  const gap = Math.max(1, w - left.length - right.length);
  const text =
    left.length + right.length + 1 > w
      ? fit(left, w)
      : left + ' '.repeat(gap) + right;
  return `\x1b[7m${fit(text, w)}\x1b[0m`;
}
