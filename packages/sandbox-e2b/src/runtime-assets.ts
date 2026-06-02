/**
 * Resolver for the small runtime payload uploaded into every E2B box at
 * create-time. Same idea as the vercel resolver, but trimmed to exactly the
 * files Task 1's `provision()` needs:
 *
 *   - `agentbox-ctl` (packages/ctl/dist/bin.cjs) — the supervisor bundle that
 *     `launchCloudCtlDaemon` execs as `/usr/local/bin/agentbox-ctl`.
 *
 * Lookup order per file:
 *   1. The CLI's staged runtime tree: `<cliRoot>/e2b/...`.
 *   2. The monorepo source tree (dev fallback) under `packages/`.
 *
 * Missing files throw a clear error naming the paths tried. Task 2 will grow
 * this list to include the prepare-time provision shims, attach helpers, and
 * VNC/relay assets — same shape as `sandbox-vercel/src/runtime-assets.ts`.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = dirname(fileURLToPath(import.meta.url));

export function findStagedCliRuntimeRoot(): string | undefined {
  const candidates = [resolve(SELF, '..', 'runtime'), resolve(SELF, '..', '..', 'runtime')];
  for (const c of candidates) {
    if (existsSync(resolve(c, 'e2b', 'ctl.cjs'))) return c;
  }
  return undefined;
}

export interface RuntimeAsset {
  /** Logical name (used in error messages + log lines). */
  name: string;
  /** Absolute path on the box (the destination for `files.write`). */
  remotePath: string;
  /** File mode to apply after upload (the in-box fixup script chmods it). */
  remoteMode: number;
}

/**
 * Where each asset lands inside the sandbox. The in-box fixup script reads
 * them from these fixed paths and `sudo cp`s the executable bits into
 * `/usr/local/bin`. We stage in `/tmp` first because E2B's default user can
 * write files.write only to user-writable paths, and `/usr/local/bin` is
 * root-owned (writes there go through sudo).
 */
export const RUNTIME_ASSETS: readonly RuntimeAsset[] = [
  { name: 'agentbox-ctl', remotePath: '/tmp/agentbox-ctl', remoteMode: 0o755 },
] as const;

export interface ResolvedAsset extends RuntimeAsset {
  localPath: string;
}

export function candidatesFor(
  name: string,
  opts: { cliRuntimeRoot?: string; repoRoot?: string } = {},
): string[] {
  const cliRoot = opts.cliRuntimeRoot;
  const monorepo = opts.repoRoot ?? guessRepoRoot();

  const monorepoRelative: Record<string, string[]> = {
    'agentbox-ctl': ['packages/ctl/dist/bin.cjs'],
  };

  const cliRelative: Record<string, string[]> = {
    'agentbox-ctl': ['e2b/ctl.cjs'],
  };

  const out: string[] = [];
  if (cliRoot) {
    for (const rel of cliRelative[name] ?? []) out.push(resolve(cliRoot, rel));
  }
  for (const rel of monorepoRelative[name] ?? []) out.push(resolve(monorepo, rel));
  return out;
}

export function resolveRuntimeAssets(
  opts: { cliRuntimeRoot?: string; repoRoot?: string } = {},
): ResolvedAsset[] {
  const out: ResolvedAsset[] = [];
  const missing: Array<{ name: string; tried: string[] }> = [];
  for (const asset of RUNTIME_ASSETS) {
    const cands = candidatesFor(asset.name, opts);
    const hit = cands.find((p) => existsSync(p));
    if (!hit) {
      missing.push({ name: asset.name, tried: cands });
      continue;
    }
    out.push({ ...asset, localPath: hit });
  }
  if (missing.length > 0) {
    const lines = missing.flatMap((m) => [`  - ${m.name}: tried`, ...m.tried.map((p) => `      ${p}`)]);
    throw new Error(
      `e2b: could not resolve runtime assets needed at create-time:\n` +
        lines.join('\n') +
        `\n\nIf running from the monorepo, ensure \`pnpm -w build\` has run so packages/ctl/dist/bin.cjs exists.`,
    );
  }
  return out;
}

function guessRepoRoot(): string {
  let cur = SELF;
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(cur, 'pnpm-workspace.yaml'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return SELF;
}
