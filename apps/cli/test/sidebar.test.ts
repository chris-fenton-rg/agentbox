import { describe, expect, it } from 'vitest';
import {
  activityCell,
  sidebarLines,
  statusLine,
  menuLines,
  lifecycleMenuLines,
  createMenuLines,
  SIDEBAR_HEADER_LINES,
  NEW_BOX_ID,
  NEW_BOX_LABEL,
} from '../src/dashboard/sidebar.js';

describe('activityCell', () => {
  it('maps claude activity for running boxes', () => {
    expect(activityCell({ id: '1', name: 'a', state: 'running', claudeActivity: 'working' })).toBe(
      '● working',
    );
    expect(activityCell({ id: '1', name: 'a', state: 'running', claudeActivity: 'waiting' })).toBe(
      '◐ waiting',
    );
    expect(activityCell({ id: '1', name: 'a', state: 'running' })).toBe('? unknown');
  });
  it('shows container state when not running', () => {
    expect(activityCell({ id: '1', name: 'a', state: 'paused' })).toBe('[paused]');
  });
});

describe('sidebarLines', () => {
  const boxes = [
    { id: 'aaa', name: 'api', state: 'running', claudeActivity: 'idle' },
    { id: 'bbb', name: 'web', state: 'stopped' },
  ];
  it('exactly h lines, each exactly w wide, selected marked', () => {
    const lines = sidebarLines(boxes, 'bbb', 24, 8);
    expect(lines).toHaveLength(8);
    for (const l of lines) expect(l).toHaveLength(24);
    const sel = lines.find((l) => l.includes('web'))!;
    expect(sel.startsWith('▸ ')).toBe(true);
    const other = lines.find((l) => l.includes('api'))!;
    expect(other.startsWith('  ')).toBe(true);
  });
  it('handles empty box list', () => {
    const lines = sidebarLines([], '', 20, 5);
    expect(lines).toHaveLength(5);
    expect(lines.some((l) => l.includes('(no boxes)'))).toBe(true);
  });
  it('renders the synthetic "+ New box" entry, selectable like a box', () => {
    const withNew = [{ id: NEW_BOX_ID, name: NEW_BOX_LABEL, state: 'new' }, ...boxes];
    const row = sidebarLines(withNew, NEW_BOX_ID, 24, 8)[SIDEBAR_HEADER_LINES]!;
    expect(row).toHaveLength(24);
    expect(row).toContain(NEW_BOX_LABEL);
    expect(row.startsWith('▸ ')).toBe(true); // selected marker
    const unsel = sidebarLines(withNew, 'aaa', 24, 8)[SIDEBAR_HEADER_LINES]!;
    expect(unsel.startsWith('  ')).toBe(true);
    expect(unsel).toContain(NEW_BOX_LABEL);
  });
  it('renders the AgentBox banner centered as the header, reserves 2 lines', () => {
    expect(SIDEBAR_HEADER_LINES).toBe(2);
    const lines = sidebarLines(boxes, 'aaa', 24, 8);
    const h = lines[0]!;
    expect(h).toHaveLength(24);
    expect(h.trim()).toContain('AgentBox');
    expect(h).not.toContain('BOXES');
    const lead = h.length - h.trimStart().length;
    const trail = h.length - h.trimEnd().length;
    expect(Math.abs(lead - trail)).toBeLessThanOrEqual(1); // centered
    expect(lead).toBeGreaterThan(0);
    expect(lines[1]!.trim()).toBe('');
  });
});

describe('statusLine', () => {
  const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
  const stripAnsi = (s: string): string => s.replace(ANSI, '');

  it('matches the tmux footer palette with white keys + gray labels', () => {
    const s = statusLine({ id: '1', name: 'api', state: 'running', claudeActivity: 'working' }, 200);
    // dark bar (truecolor #303030), blue brand (39), gray labels (245), white keys (255)
    expect(s).toContain('48;2;48;48;48');
    expect(s).toContain('48;5;39');
    expect(s).toContain('38;5;245');
    expect(s).toContain('38;5;255');
    expect(s.endsWith('\x1b[0m')).toBe(true);
    // "agentbox" stays normal weight; bold starts at the box name.
    expect(s).toContain('▸ \x1b[1mapi');
    expect(s).not.toContain('\x1b[1m agentbox');
    const printable = stripAnsi(s);
    expect(printable).toHaveLength(200);
    expect(printable).toContain('api');
  });

  it('falls back to just the brand block when too narrow for hints', () => {
    const s = statusLine({ id: '1', name: 'api', state: 'running', claudeActivity: 'idle' }, 40);
    expect(s).toContain('48;5;39');
    expect(stripAnsi(s)).toHaveLength(40);
  });

  it('spells keys by name (no ⌥/^ glyphs) as "KEYS: label"', () => {
    const s = statusLine({ id: '1', name: 'api', state: 'running', claudeActivity: 'idle' }, 200);
    const printable = stripAnsi(s);
    expect(printable).toHaveLength(200);
    expect(printable).toContain('Control+a c: code');
    expect(printable).toContain('Control+Option+Up/Down: switch');
    expect(printable).toContain('│');
    expect(printable).not.toContain('⌥');
    expect(printable).not.toContain('^a');
  });

  it('uses the stateLabel override (shell/menu) instead of claudeActivity', () => {
    const box = { id: '1', name: 'api', state: 'running', claudeActivity: 'unknown' };
    expect(statusLine(box, 60, 'shell')).toContain('api (shell)');
    expect(statusLine(box, 60, 'menu')).toContain('api (menu)');
    expect(statusLine(box, 60)).toContain('api (unknown)');
  });
});

describe('menuLines', () => {
  it('is exactly h lines × w cols and offers the c/s actions', () => {
    const lines = menuLines('web-2', 40, 20);
    expect(lines).toHaveLength(20);
    for (const l of lines) expect(l).toHaveLength(40);
    const joined = lines.join('\n');
    expect(joined).toContain('No Claude session in web-2.');
    expect(joined).toContain('[c]  Start Claude here');
    expect(joined).toContain('[s]  Open a shell');
  });

  it('clamps content when the pane is short', () => {
    const lines = menuLines('b', 30, 3);
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(l).toHaveLength(30);
  });
});

describe('lifecycleMenuLines', () => {
  it('paused: offers Unpause + Destroy, exactly h × w', () => {
    const lines = lifecycleMenuLines('api-1', 'paused', false, 44, 18);
    expect(lines).toHaveLength(18);
    for (const l of lines) expect(l).toHaveLength(44);
    const joined = lines.join('\n');
    expect(joined).toContain('Box api-1 is paused.');
    expect(joined).toContain('[u]  Unpause');
    expect(joined).toContain('[d]  Destroy');
    expect(joined).not.toContain('[s]  Start');
  });

  it('stopped: offers Start instead of Unpause', () => {
    const joined = lifecycleMenuLines('web', 'stopped', false, 44, 18).join('\n');
    expect(joined).toContain('Box web is stopped.');
    expect(joined).toContain('[s]  Start');
    expect(joined).not.toContain('[u]  Unpause');
  });

  it('confirmDestroy swaps to the y/cancel confirm body', () => {
    const lines = lifecycleMenuLines('api-1', 'paused', true, 44, 18);
    expect(lines).toHaveLength(18);
    for (const l of lines) expect(l).toHaveLength(44);
    const joined = lines.join('\n');
    expect(joined).toContain('Destroy api-1?');
    expect(joined).toContain('[y]  Yes, destroy');
    expect(joined).toContain('Cancel');
    expect(joined).not.toContain('[u]  Unpause');
  });

  it('clamps content when the pane is short', () => {
    const lines = lifecycleMenuLines('b', 'stopped', false, 30, 3);
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(l).toHaveLength(30);
  });
});

describe('createMenuLines', () => {
  it('is exactly h lines × w cols and offers create-with/without-claude', () => {
    const lines = createMenuLines('/home/me/proj', 50, 20);
    expect(lines).toHaveLength(20);
    for (const l of lines) expect(l).toHaveLength(50);
    const joined = lines.join('\n');
    expect(joined).toContain('Create a new box');
    expect(joined).toContain('[c]  Create + launch Claude');
    expect(joined).toContain('[n]  Create only');
    expect(joined).toContain('/home/me/proj');
  });

  it('clamps content when the pane is short', () => {
    const lines = createMenuLines('/x', 30, 3);
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(l).toHaveLength(30);
  });
});
