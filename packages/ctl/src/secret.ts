import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_LOG_DIR } from './types.js';
import { resolveWritableStateDir } from './state-dir.js';

// {{AGENTBOX_AUTO_SECRET}} or {{AGENTBOX_AUTO_SECRET:<name>}}. Its own grammar
// (allows `:` + lowercase names), separate from the [A-Z0-9_] placeholder
// whitelist in replace.ts.
const SECRET_RE = /\{\{\s*AGENTBOX_AUTO_SECRET(?::([A-Za-z0-9_-]+))?\s*\}\}/g;
const SECRET_BYTES = 32; // 32 bytes → 43-char base64url, matches `openssl rand -base64 32`

function generateSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url');
}

/**
 * Replace `{{AGENTBOX_AUTO_SECRET}}` tokens in `content`:
 * - unnamed → a fresh random secret per occurrence (stable in practice because
 *   the template→output render is guarded to run once).
 * - `:<name>` → generated once and persisted at `<stateDir>/secrets/<name>`,
 *   reused on every later render so it's stable even if rendered every boot.
 *
 * No tokens → returns `content` untouched without touching the state dir.
 */
export async function resolveAutoSecrets(
  content: string,
  opts: { stateDir?: string; logDir?: string; onLog?: (msg: string) => void } = {},
): Promise<string> {
  // Cheap bail-out that doesn't disturb the shared regex's lastIndex.
  if (!content.includes('AGENTBOX_AUTO_SECRET')) return content;

  const names = new Set<string>();
  SECRET_RE.lastIndex = 0;
  for (const m of content.matchAll(SECRET_RE)) if (m[1]) names.add(m[1]);

  const named = new Map<string, string>();
  if (names.size > 0) {
    const base = await resolveWritableStateDir(
      opts.stateDir,
      opts.logDir ?? DEFAULT_LOG_DIR,
      'secrets',
      (msg) => opts.onLog?.(msg),
    );
    const dir = join(base, 'secrets');
    for (const name of names) named.set(name, await loadOrCreateSecret(dir, name, opts.onLog));
  }

  return content.replace(SECRET_RE, (_match, name?: string) =>
    name ? named.get(name)! : generateSecret(),
  );
}

async function loadOrCreateSecret(
  dir: string,
  name: string,
  onLog?: (msg: string) => void,
): Promise<string> {
  const file = join(dir, name);
  try {
    const existing = (await readFile(file, 'utf8')).trim();
    if (existing.length > 0) return existing;
  } catch {
    // missing/unreadable → create below
  }
  const secret = generateSecret();
  await mkdir(dir, { recursive: true });
  await writeFile(file, `${secret}\n`, { mode: 0o600 });
  onLog?.(`generated persisted secret "${name}"`);
  return secret;
}
