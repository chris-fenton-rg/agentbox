import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Daytona env auto-loader. The SDK reads `DAYTONA_API_KEY` /
 * `DAYTONA_JWT_TOKEN` + `DAYTONA_ORGANIZATION_ID` from `process.env`. We pull
 * those keys in from `~/.agentbox/secrets.env` so the SDK Just Works after
 * the user runs `agentbox daytona login` once.
 *
 * Lookup order (first wins; process.env is never overwritten):
 *   1. `process.env` (already set in the shell).
 *   2. `~/.agentbox/secrets.env` — written by `agentbox daytona login`.
 *
 * Project-level `.env` / `.env.local` are intentionally NOT consulted: those
 * files belong to the app code being developed, and a `DAYTONA_API_KEY`
 * there is typically meant for in-box code execution, not for the host CLI
 * to harvest and provision sandboxes with.
 *
 * Only Daytona-prefixed keys are imported; the rest of the file is left
 * alone. The loader is idempotent and side-effect-free after the first call.
 */
const DAYTONA_KEYS = [
  'DAYTONA_API_KEY',
  'DAYTONA_JWT_TOKEN',
  'DAYTONA_ORGANIZATION_ID',
  'DAYTONA_API_URL',
  'DAYTONA_TARGET',
] as const;

let loaded = false;

export function ensureDaytonaEnvLoaded(): void {
  if (loaded) return;
  loaded = true;
  importDaytonaFromFile(resolve(homedir(), '.agentbox', 'secrets.env'));
}

function importDaytonaFromFile(path: string): void {
  if (!existsSync(path)) return;
  let body: string;
  try {
    body = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  const parsed = parseEnvFile(body);
  for (const key of DAYTONA_KEYS) {
    if (process.env[key] !== undefined) continue;
    const value = parsed[key];
    if (typeof value === 'string') {
      process.env[key] = value;
    }
  }
}

/**
 * Minimal `.env` parser: handles `KEY=value`, `KEY="value with spaces"`,
 * `KEY='value with $special chars'`, `export KEY=value`, blank lines, and
 * `#` comments. Doesn't do variable interpolation — that's surprising to
 * users coming from full dotenv, but secrets typically don't reference each
 * other and we'd rather be predictable.
 */
export function parseEnvFile(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const stripped = line.startsWith('export ') ? line.slice('export '.length) : line;
    const eq = stripped.indexOf('=');
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    let value = stripped.slice(eq + 1).trim();
    // Strip surrounding quotes (single or double).
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
