import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rpc } from './client.js';
import { runDaemon } from './daemon.js';
import { parseKeys } from './keys.js';
import { harnessDir, logPath, metaPath, pidPath, sockPath, type SessionMeta } from './paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// drive.ts -> apps/cli/test/_harness/drive.ts -> repo root is 4 up.
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules/.bin/tsx');

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sub = argv[0];

  // Internal: daemon child re-entry. Args after `__daemon`: a single JSON blob.
  if (sub === '__daemon') {
    const payload = argv[1];
    if (!payload) {
      process.stderr.write('drive __daemon: missing payload\n');
      process.exit(2);
    }
    const opts = JSON.parse(payload) as {
      id: string;
      cols: number;
      rows: number;
      cwd: string;
      env: NodeJS.ProcessEnv;
      command: string;
      args: string[];
    };
    await runDaemon(opts);
    return;
  }

  if (!sub || sub === '-h' || sub === '--help' || sub === 'help') {
    printHelp();
    process.exit(0);
  }

  switch (sub) {
    case 'start':
      await cmdStart(argv.slice(1));
      return;
    case 'screen':
      await cmdScreen(argv.slice(1));
      return;
    case 'send':
      await cmdSend(argv.slice(1));
      return;
    case 'resize':
      await cmdResize(argv.slice(1));
      return;
    case 'wait':
      await cmdWait(argv.slice(1));
      return;
    case 'list':
      cmdList(argv.slice(1));
      return;
    case 'stop':
      await cmdStop(argv.slice(1));
      return;
    default:
      process.stderr.write(`drive: unknown subcommand '${sub}'\n`);
      printHelp();
      process.exit(2);
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      'drive — PTY driver for interactive validation',
      '',
      'Usage:',
      '  drive start [--cols C] [--rows R] [--name LABEL] [--cwd DIR] [--env K=V]... -- <cmd> [args...]',
      '  drive screen <id> [--ansi] [--with-cursor] [--rows R1:R2]',
      '  drive send <id> <keys...>',
      '  drive resize <id> <cols> <rows>',
      '  drive wait <id> [--text "..."] [--timeout 5000]',
      '  drive list [--json]',
      '  drive stop <id> | drive stop --all',
      '',
      'Keys DSL: literal text + <Enter> <Tab> <Esc> <Space> <BS> <Del>',
      '          <C-a>..<C-z>  <Up>/<Down>/<Left>/<Right>',
      '          <Home>/<End>/<PageUp>/<PageDown>  <F1>..<F12>',
      '          `<<` escapes a literal `<`.',
      '',
    ].join('\n'),
  );
}

interface StartFlags {
  cols: number;
  rows: number;
  name?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  json: boolean;
  cmd: string;
  args: string[];
}

function parseStartFlags(argv: string[]): StartFlags {
  let cols = 120;
  let rows = 40;
  let name: string | undefined;
  let cwd = process.cwd();
  const env: NodeJS.ProcessEnv = { ...process.env };
  let json = false;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') {
      i += 1;
      break;
    } else if (a === '--cols') {
      cols = parseInt(needArg(argv, ++i, '--cols'), 10);
    } else if (a === '--rows') {
      rows = parseInt(needArg(argv, ++i, '--rows'), 10);
    } else if (a === '--name') {
      name = needArg(argv, ++i, '--name');
    } else if (a === '--cwd') {
      cwd = path.resolve(needArg(argv, ++i, '--cwd'));
    } else if (a === '--env') {
      const kv = needArg(argv, ++i, '--env');
      const eq = kv.indexOf('=');
      if (eq === -1) throw new Error(`--env expects K=V (got: ${kv})`);
      env[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a === '--json') {
      json = true;
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
    i += 1;
  }
  const rest = argv.slice(i);
  if (rest.length === 0) throw new Error('start: no command after `--`');
  const cmd = rest[0];
  const args = rest.slice(1);
  if (!cmd) throw new Error('start: no command after `--`');
  if (!Number.isFinite(cols) || cols <= 0) throw new Error('--cols must be positive int');
  if (!Number.isFinite(rows) || rows <= 0) throw new Error('--rows must be positive int');
  return { cols, rows, name, cwd, env, json, cmd, args };
}

async function cmdStart(argv: string[]): Promise<void> {
  const f = parseStartFlags(argv);
  fs.mkdirSync(harnessDir(), { recursive: true });
  const id = f.name
    ? `${slugify(f.name)}-${randomBytes(2).toString('hex')}`
    : randomBytes(4).toString('hex');

  const payload = JSON.stringify({
    id,
    cols: f.cols,
    rows: f.rows,
    cwd: f.cwd,
    env: f.env,
    command: f.cmd,
    args: f.args,
  });

  // Open a log file the detached daemon writes its stderr to; useful for
  // post-mortem when the inner command failed to start.
  const logFd = fs.openSync(logPath(id), 'a');

  if (!fs.existsSync(TSX_BIN)) {
    throw new Error(
      `tsx not installed at ${TSX_BIN}. Run \`pnpm install\` at the repo root first.`,
    );
  }

  const child = spawn(TSX_BIN, [__filename, '__daemon', payload], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: REPO_ROOT,
    env: process.env,
  });
  child.unref();
  fs.closeSync(logFd);

  // Wait for the socket to appear (daemon started + listening). Cap at 5s
  // so a wedged child doesn't hang the caller forever.
  const sock = sockPath(id);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (fs.existsSync(sock)) break;
    await sleep(40);
  }
  if (!fs.existsSync(sock)) {
    const tail = readTail(logPath(id), 40);
    throw new Error(
      `drive start: daemon did not come up within 5s (id=${id})\n--- log tail ---\n${tail}`,
    );
  }

  if (f.json) {
    process.stdout.write(
      JSON.stringify({ id, pid: child.pid, socket: sock, log: logPath(id) }) + '\n',
    );
  } else {
    process.stdout.write(`${id}\n`);
  }
}

async function cmdScreen(argv: string[]): Promise<void> {
  const id = argv[0];
  if (!id) throw new Error('screen: missing <id>');
  let ansi = false;
  let withCursor = false;
  let range: [number, number] | undefined;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ansi') ansi = true;
    else if (a === '--with-cursor') withCursor = true;
    else if (a === '--rows') {
      const v = argv[++i];
      const m = /^(\d+):(\d+)$/.exec(v ?? '');
      if (!m || !m[1] || !m[2]) throw new Error('--rows expects R1:R2');
      range = [parseInt(m[1], 10), parseInt(m[2], 10)];
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
  }
  const res = await rpc(id, { op: 'screen', ansi, withCursor, rows: range });
  if (!res.ok) {
    process.stderr.write(`drive: ${res.error}\n`);
    process.exit(1);
  }
  process.stdout.write((res.text ?? '') + '\n');
}

async function cmdSend(argv: string[]): Promise<void> {
  const id = argv[0];
  if (!id) throw new Error('send: missing <id>');
  const keys = argv.slice(1).join('');
  if (!keys) throw new Error('send: no keys');
  const data = parseKeys(keys);
  const res = await rpc(id, { op: 'send', data });
  if (!res.ok) {
    process.stderr.write(`drive: ${res.error}\n`);
    process.exit(1);
  }
}

async function cmdResize(argv: string[]): Promise<void> {
  const [id, colsStr, rowsStr] = argv;
  if (!id || !colsStr || !rowsStr) throw new Error('resize: <id> <cols> <rows>');
  const cols = parseInt(colsStr, 10);
  const rows = parseInt(rowsStr, 10);
  const res = await rpc(id, { op: 'resize', cols, rows });
  if (!res.ok) {
    process.stderr.write(`drive: ${res.error}\n`);
    process.exit(1);
  }
}

async function cmdWait(argv: string[]): Promise<void> {
  const id = argv[0];
  if (!id) throw new Error('wait: missing <id>');
  let text: string | undefined;
  let timeoutMs = 5000;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--text') text = argv[++i];
    else if (a === '--timeout') {
      const v = argv[++i];
      if (!v) throw new Error('--timeout expects a number');
      timeoutMs = parseInt(v, 10);
    } else throw new Error(`unknown flag: ${a}`);
  }
  if (!text) throw new Error('wait: --text required');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await rpc(id, { op: 'screen' });
    if (res.ok && (res.text ?? '').includes(text)) {
      return;
    }
    await sleep(80);
  }
  process.stderr.write(`drive: timed out waiting for "${text}" in session ${id}\n`);
  process.exit(1);
}

function cmdList(argv: string[]): void {
  const json = argv.includes('--json');
  const dir = harnessDir();
  const entries: SessionMeta[] = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.meta')) continue;
      try {
        const raw = fs.readFileSync(path.join(dir, name), 'utf8');
        entries.push(JSON.parse(raw) as SessionMeta);
      } catch {
        /* skip torn writes */
      }
    }
  } catch {
    /* harness dir does not exist yet */
  }
  // Stamp `alive` from the pid file (cheap) before printing.
  const rows = entries.map((m) => ({ ...m, alive: isAlive(m.pid) }));
  if (json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return;
  }
  if (rows.length === 0) {
    process.stdout.write('(no sessions)\n');
    return;
  }
  for (const r of rows) {
    const cmd = [r.command, ...r.args].join(' ');
    const flag = r.alive ? 'alive' : 'dead';
    process.stdout.write(
      `${r.id}  ${flag.padEnd(5)}  pid=${r.pid}  ${r.cols}x${r.rows}  ${r.startedAt}  ${cmd}\n`,
    );
  }
}

async function cmdStop(argv: string[]): Promise<void> {
  if (argv.includes('--all')) {
    const dir = harnessDir();
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.meta')) continue;
      const id = name.slice(0, -'.meta'.length);
      await stopOne(id).catch(() => {
        /* ignore — best effort */
      });
    }
    return;
  }
  const id = argv[0];
  if (!id) throw new Error('stop: <id> or --all');
  await stopOne(id);
}

async function stopOne(id: string): Promise<void> {
  try {
    await rpc(id, { op: 'stop' }, 1500);
  } catch {
    // Daemon may already be dead or socket gone. Fall back to SIGTERM
    // via the recorded PID and hand-cleanup of the meta/sock files.
    try {
      const pid = parseInt(fs.readFileSync(pidPath(id), 'utf8'), 10);
      if (Number.isFinite(pid)) process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    for (const p of [sockPath(id), pidPath(id), metaPath(id)]) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* gone */
      }
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readTail(file: string, lines: number): string {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const arr = txt.split('\n');
    return arr.slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

function needArg(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined) throw new Error(`${flag}: missing value`);
  return v;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e: Error) => {
  process.stderr.write(`drive: ${e.message}\n`);
  process.exit(1);
});
