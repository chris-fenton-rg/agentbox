import { describe, expect, it } from 'vitest';
import { activityCell, sidebarLines, statusLine, menuLines } from '../src/dashboard/sidebar.js';

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
});

describe('statusLine', () => {
  it('is inverse video and exactly w printable columns', () => {
    const s = statusLine({ id: '1', name: 'api', state: 'running', claudeActivity: 'working' }, 60);
    expect(s.startsWith('\x1b[7m')).toBe(true);
    expect(s.endsWith('\x1b[0m')).toBe(true);
    const printable = s.replace('\x1b[7m', '').replace('\x1b[0m', '');
    expect(printable).toHaveLength(60);
    expect(printable).toContain('api');
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
