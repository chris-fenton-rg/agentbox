import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src/config.js';

describe('parseConfig', () => {
  it('returns empty services for empty or absent doc', () => {
    expect(parseConfig('')).toEqual({ services: [], tasks: [], replacements: {} });
    expect(parseConfig('services: {}')).toEqual({ services: [], tasks: [], replacements: {} });
  });

  it('parses a minimal service with shell-string command', () => {
    const cfg = parseConfig(`
services:
  web:
    command: pnpm dev
`);
    expect(cfg.services).toHaveLength(1);
    const svc = cfg.services[0]!;
    expect(svc.name).toBe('web');
    expect(svc.command).toBe('pnpm dev');
    expect(svc.autostart).toBe(true);
    expect(svc.restart).toBe('on-failure');
    expect(svc.backoff.initialMs).toBe(500);
  });

  it('parses argv command + env + restart policy + backoff', () => {
    const cfg = parseConfig(`
services:
  worker:
    command: ["node", "worker.js"]
    cwd: apps/worker
    env:
      LOG_LEVEL: debug
      PORT: 4000
    restart: always
    backoff:
      initial_ms: 1000
      max_ms: 60000
      factor: 3
`);
    const svc = cfg.services[0]!;
    expect(svc.command).toEqual(['node', 'worker.js']);
    expect(svc.cwd).toBe('apps/worker');
    expect(svc.env).toEqual({ LOG_LEVEL: 'debug', PORT: '4000' });
    expect(svc.restart).toBe('always');
    expect(svc.backoff).toEqual({ initialMs: 1000, maxMs: 60000, factor: 3 });
  });

  it('rejects empty command', () => {
    expect(() => parseConfig(`services:\n  web:\n    command: ""\n`)).toThrow(ConfigError);
  });

  it('rejects empty argv', () => {
    expect(() => parseConfig(`services:\n  web:\n    command: []\n`)).toThrow(ConfigError);
  });

  it('rejects unknown restart policy', () => {
    expect(() => parseConfig(`services:\n  web:\n    command: foo\n    restart: maybe\n`)).toThrow(
      /restart must be one of/,
    );
  });

  it('rejects max < initial backoff', () => {
    expect(() =>
      parseConfig(`
services:
  web:
    command: foo
    backoff:
      initial_ms: 5000
      max_ms: 100
`),
    ).toThrow(/max_ms must be >= initial_ms/);
  });

  it('rejects invalid service name', () => {
    expect(() => parseConfig(`services:\n  "bad name":\n    command: foo\n`)).toThrow(/must match/);
  });
});

describe('image services', () => {
  function svc(yaml: string) {
    return parseConfig(yaml).services[0]!;
  }

  it('synthesizes a start-or-run command from a nested image (ports/env/args)', () => {
    const s = svc(`
services:
  postgres:
    image:
      name: postgres:17-alpine
      ports: ["5437:5432"]
      env:
        POSTGRES_USER: optima
        POSTGRES_PASSWORD: "with space"
      args: "-c max_connections=200"
      container_name: optima_db
`);
    expect(s.image).toBe('postgres:17-alpine');
    expect(s.containerName).toBe('optima_db');
    expect(s.ports).toEqual(['5437:5432']);
    const cmd = s.command as string;
    expect(cmd).toContain('docker container inspect optima_db');
    expect(cmd).toContain('docker start optima_db');
    expect(cmd).toContain('docker run --name optima_db -p 5437:5432');
    expect(cmd).toContain('-e POSTGRES_USER=optima');
    expect(cmd).toContain("-e POSTGRES_PASSWORD='with space'"); // shell-quoted value
    expect(cmd).toContain('postgres:17-alpine -c max_connections=200');
    expect(s.env).toBeUndefined(); // container env is baked into -e, not the process env
  });

  it('accepts the image string shorthand, defaulting container name to the service name', () => {
    const s = svc(`services:\n  cache:\n    image: redis:7\n`);
    expect(s.image).toBe('redis:7');
    expect(s.containerName).toBe('cache');
    expect(s.command as string).toContain('docker run --name cache');
  });

  it('joins args lists', () => {
    const s = svc(`services:\n  cache:\n    image:\n      name: redis:7\n      args: ["--save", "60 1"]\n`);
    expect(s.command as string).toContain('redis:7 --save 60 1');
  });

  it('rejects command + image together', () => {
    expect(() => svc(`services:\n  db:\n    command: x\n    image: postgres\n`)).toThrow(
      ConfigError,
    );
  });

  it('rejects neither command nor image', () => {
    expect(() => svc(`services:\n  db:\n    restart: always\n`)).toThrow(/command or image/);
  });

  it('rejects top-level env on an image service', () => {
    expect(() => svc(`services:\n  db:\n    image: postgres\n    env:\n      X: y\n`)).toThrow(
      /use image\.env/,
    );
  });

  it('rejects an image mapping without name', () => {
    expect(() => svc(`services:\n  db:\n    image:\n      ports: ["5432:5432"]\n`)).toThrow(
      ConfigError,
    );
  });

  it('rejects a bad container_name', () => {
    expect(() =>
      svc(`services:\n  db:\n    image:\n      name: postgres\n      container_name: "bad name"\n`),
    ).toThrow(/not a valid docker container name/);
  });
});
