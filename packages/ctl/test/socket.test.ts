import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { startServer } from '../src/socket.js';
import { Supervisor } from '../src/supervisor.js';
import { claudeSession, ping, status, logs } from '../src/client.js';
import type { ServiceSpec } from '../src/config.js';
import type { Server } from 'node:net';

const NODE = process.execPath;

function spec(
  over: Partial<ServiceSpec> & { name: string; command: string | string[] },
): ServiceSpec {
  return {
    autostart: true,
    restart: 'on-failure',
    backoff: { initialMs: 10, maxMs: 50, factor: 2 },
    ...over,
  };
}

describe('socket protocol', () => {
  let dir: string;
  let sock: string;
  let server: Server;
  let sup: Supervisor;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ctl-sock-'));
    sock = join(dir, 'ctl.sock');
    sup = new Supervisor({ workspace: dir, logDir: dir });
    await sup.init([
      spec({
        name: 'svc',
        command: [NODE, '-e', 'console.log("hi"); setInterval(()=>console.log("tick"),20)'],
      }),
    ]);
    server = await startServer({
      socketPath: sock,
      supervisor: sup,
      logDir: dir,
      configPath: join(dir, 'nope.yaml'),
    });
  });

  afterEach(async () => {
    server.close();
    await sup.stopAll();
    await rm(dir, { recursive: true, force: true });
  });

  it('responds to ping', async () => {
    expect(await ping({ socketPath: sock })).toBe('pong');
  });

  it('returns service status list', async () => {
    const list = await status({ socketPath: sock });
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('svc');
  });

  it('returns initial log lines without follow', async () => {
    // Give the service a moment to emit some lines.
    await new Promise((r) => setTimeout(r, 100));
    const result = await logs({ socketPath: sock }, { service: 'svc', tail: 50, follow: false });
    expect(result.initial.some((e) => e.line === 'hi' || e.line === 'tick')).toBe(true);
    expect(result.follow).toBeUndefined();
  });

  it('streams new lines when follow=true', async () => {
    const result = await logs({ socketPath: sock }, { service: 'svc', tail: 5, follow: true });
    expect(result.follow).toBeDefined();
    let got = false;
    const deadline = Date.now() + 1500;
    for await (const ev of result.follow!) {
      if (ev.line === 'tick') {
        got = true;
        break;
      }
      if (Date.now() > deadline) break;
    }
    expect(got).toBe(true);
  });

  it('claude-session reports running=false for a non-existent session name', async () => {
    // Random name guarantees no collision with a real tmux session that might
    // happen to be running in this user's env. Whether tmux is installed or
    // not, has-session for a missing name returns non-zero -> running: false.
    const uniqueName = `agentbox-test-${randomBytes(4).toString('hex')}`;
    const result = await claudeSession({ socketPath: sock, sessionName: uniqueName });
    expect(result.running).toBe(false);
    expect(result.sessionName).toBe(uniqueName);
    expect(result.startedAt).toBeNull();
  });
});
