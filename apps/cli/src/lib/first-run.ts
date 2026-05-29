/**
 * First-run detection for the `agentbox install` auto-trigger in `index.ts`.
 *
 * We can't rely on bare `~/.agentbox` existence — other flows (provider
 * `login`, `~/.agentbox/logs/...`) create it lazily — so we write a dedicated
 * marker at the end of a successful wizard run. Marker absent ⇒ first run.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const MARKER_VERSION = 1 as const;

export function setupMarkerPath(): string {
  return join(homedir(), '.agentbox', 'setup-complete.json');
}

export function isFirstRun(): boolean {
  return !existsSync(setupMarkerPath());
}

export interface SetupMarker {
  version: typeof MARKER_VERSION;
  completedAt: string;
  /** Provider the user picked during the wizard run that wrote the marker. */
  provider?: string;
}

export function markSetupComplete(provider?: string): void {
  const path = setupMarkerPath();
  mkdirSync(dirname(path), { recursive: true });
  const body: SetupMarker = {
    version: MARKER_VERSION,
    completedAt: new Date().toISOString(),
    provider,
  };
  writeFileSync(path, JSON.stringify(body, null, 2) + '\n');
}
