import net from 'node:net';
import { sockPath } from './paths.js';

export interface ScreenReq {
  op: 'screen';
  ansi?: boolean;
  withCursor?: boolean;
  rows?: [number, number];
}
export interface SendReq {
  op: 'send';
  data: string;
}
export interface ResizeReq {
  op: 'resize';
  cols: number;
  rows: number;
}
export interface MetaReq {
  op: 'meta';
}
export interface StopReq {
  op: 'stop';
}

export type Request = ScreenReq | SendReq | ResizeReq | MetaReq | StopReq;

export interface OkResponse {
  ok: true;
  // Discriminated by op; always defined for the op that returns one.
  text?: string;
  meta?: {
    id: string;
    pid: number;
    command: string;
    args: string[];
    cols: number;
    rows: number;
    startedAt: string;
    cwd: string;
    alive: boolean;
    cursor: { x: number; y: number };
  };
}
export interface ErrResponse {
  ok: false;
  error: string;
}
export type Response = OkResponse | ErrResponse;

/**
 * Send one JSON request to the session's UDS, receive one JSON response.
 * The daemon closes the socket after responding; this resolves on close.
 */
export async function rpc(id: string, req: Request, timeoutMs = 5000): Promise<Response> {
  const sock = sockPath(id);
  return new Promise<Response>((resolve, reject) => {
    const client = net.createConnection(sock);
    let buf = '';
    const t = setTimeout(() => {
      client.destroy();
      reject(new Error(`drive: timed out talking to session ${id}`));
    }, timeoutMs);
    client.on('connect', () => {
      client.write(JSON.stringify(req) + '\n');
    });
    client.on('data', (chunk) => {
      buf += chunk.toString('utf8');
    });
    client.on('end', () => {
      clearTimeout(t);
      try {
        resolve(JSON.parse(buf.trim()) as Response);
      } catch (e) {
        reject(new Error(`drive: malformed response: ${(e as Error).message}`));
      }
    });
    client.on('error', (e) => {
      clearTimeout(t);
      reject(new Error(`drive: socket error for ${id}: ${e.message}`));
    });
  });
}
