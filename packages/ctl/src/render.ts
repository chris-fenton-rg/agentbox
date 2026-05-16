import type { BoxStatusPort, ServiceStatus, TaskStatus } from './types.js';

export function renderStatusTable(rows: ServiceStatus[]): string {
  if (rows.length === 0) return '(no services configured)';
  const headers = ['NAME', 'STATE', 'PID', 'RESTARTS', 'LAST EXIT', 'BLOCKED ON', 'COMMAND'];
  const data: string[][] = rows.map((r) => [
    r.name,
    r.state,
    r.pid === null ? '-' : String(r.pid),
    String(r.restarts),
    r.lastExitCode === null ? '-' : String(r.lastExitCode),
    r.blockedOn.length === 0 ? '-' : r.blockedOn.join(','),
    truncate(r.command, 40),
  ]);
  return renderTable(headers, data);
}

export function renderTaskTable(rows: TaskStatus[]): string {
  if (rows.length === 0) return '(no tasks configured)';
  const headers = ['NAME', 'STATE', 'EXIT', 'STARTED', 'FINISHED', 'COMMAND'];
  const data: string[][] = rows.map((r) => [
    r.name,
    r.state,
    r.lastExitCode === null ? '-' : String(r.lastExitCode),
    r.startedAt ?? '-',
    r.finishedAt ?? '-',
    truncate(r.command, 40),
  ]);
  return renderTable(headers, data);
}

export function renderPortsTable(rows: BoxStatusPort[]): string {
  if (rows.length === 0) return '(no ports listening)';
  const named = rows.filter((r) => r.service);
  const other = rows
    .filter((r) => !r.service)
    .map((r) => r.port)
    .sort((a, b) => a - b);
  const lines: string[] = [];
  if (named.length > 0) {
    lines.push(
      renderTable(
        ['PORT', 'SERVICE'],
        named.map((r) => [`:${String(r.port)}`, r.service ?? '-']),
      ),
    );
  }
  // Collapse the unattributed ports (VNC, dev-tool worker IPC, multi-port
  // services like inngest) into one line so they don't drown the real services.
  if (other.length > 0) {
    lines.push(`other (${other.length}): ${other.join(', ')}`);
  }
  return lines.join('\n');
}

function renderTable(headers: string[], data: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map((row) => (row[i] ?? '').length)),
  );
  const fmt = (row: string[]): string =>
    row.map((cell, i) => cell.padEnd(widths[i] ?? cell.length)).join('  ');
  return [fmt(headers), ...data.map(fmt)].join('\n');
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
