/**
 * Resolve the current `box.credentialForwarding` policy. Re-reads the
 * effective config on every call so config changes (via
 * `agentbox config set …`) pick up immediately without restarting the
 * relay. Matches the autopause/queue pattern in
 * `packages/relay/src/autopause.ts`.
 */

import { loadEffectiveConfig } from './load.js';
import type { CredentialForwarding } from './types.js';

export async function loadCredentialForwarding(cwd?: string): Promise<CredentialForwarding> {
  const cfg = await loadEffectiveConfig(cwd ?? process.cwd());
  return cfg.effective.box.credentialForwarding;
}
