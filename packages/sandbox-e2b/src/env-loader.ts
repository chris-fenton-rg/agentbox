/**
 * E2B env auto-loader. The `e2b` SDK reads `E2B_API_KEY` (and optionally
 * `E2B_DOMAIN` for non-default deployments) from `process.env`. We seed those
 * from `~/.agentbox/secrets.env` (written by `agentbox e2b login`) so the SDK
 * Just Works after a one-time login — same pattern as the daytona / hetzner /
 * vercel env-loaders.
 *
 * Lookup order (first wins; process.env is never overwritten):
 *   1. `process.env` (already set in the shell).
 *   2. `~/.agentbox/secrets.env` — written by `agentbox e2b login`.
 *
 * Project-level `.env` / `.env.local` are intentionally NOT consulted: those
 * files belong to the app code being developed. Put host credentials in
 * `~/.agentbox/secrets.env` (or the shell env).
 *
 * Only E2B-prefixed keys are imported; the rest of the file is left alone.
 * Idempotent and side-effect-free after the first call.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const E2B_KEYS = ['E2B_API_KEY', 'E2B_DOMAIN'] as const;

let loaded = false;

export function ensureE2bEnvLoaded(): void {
  if (loaded) return;
  loaded = true;
  importE2bFromFile(resolve(homedir(), '.agentbox', 'secrets.env'), E2B_KEYS);
}

/**
 * Force a re-read of `~/.agentbox/secrets.env`. Used by the interactive
 * `agentbox e2b login` flow after it persists the API key, so the same process
 * can pick it up without a restart.
 */
export function reloadE2bEnv(): void {
  loaded = false;
  ensureE2bEnvLoaded();
}

function importE2bFromFile(path: string, keys: readonly string[]): void {
  if (!existsSync(path)) return;
  let body: string;
  try {
    body = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  const parsed = parseEnvFile(body);
  for (const key of keys) {
    if (process.env[key] !== undefined) continue;
    const value = parsed[key];
    if (typeof value === 'string') {
      process.env[key] = value;
    }
  }
}

/**
 * Minimal `.env` parser: handles `KEY=value`, `KEY="value"`, `KEY='value'`,
 * `export KEY=value`, blank lines, and `#` comments. No variable interpolation
 * — predictable over feature-complete (matches the daytona / vercel loaders).
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
