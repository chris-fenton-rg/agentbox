import os from 'node:os';
import path from 'node:path';

export function harnessDir(): string {
  return path.join(os.tmpdir(), 'agentbox-drive');
}

export function sockPath(id: string): string {
  return path.join(harnessDir(), `${id}.sock`);
}

export function pidPath(id: string): string {
  return path.join(harnessDir(), `${id}.pid`);
}

export function metaPath(id: string): string {
  return path.join(harnessDir(), `${id}.meta`);
}

export function logPath(id: string): string {
  return path.join(harnessDir(), `${id}.log`);
}

export interface SessionMeta {
  id: string;
  pid: number;
  command: string;
  args: string[];
  cols: number;
  rows: number;
  startedAt: string;
  cwd: string;
  socket: string;
}
