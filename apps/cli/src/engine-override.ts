import { loadEffectiveConfig } from '@agentbox/config';
import { setEngineOverride } from '@agentbox/sandbox-docker';

/**
 * Pin the docker engine if the user has set `engine.kind` in any layer (other
 * than `auto`, which means "let `docker info` decide"). Called once from the
 * CLI entrypoint before commander parses argv. Errors are swallowed — if the
 * user's config is broken, the matching `agentbox config` subcommand will
 * surface a clean error when they next touch it.
 */
export async function applyEngineOverrideAtStartup(): Promise<void> {
  try {
    const loaded = await loadEffectiveConfig(process.cwd());
    const kind = loaded.effective.engine.kind;
    if (kind === 'auto') return;
    setEngineOverride(kind);
  } catch {
    /* best-effort: lint, --help, and other no-op invocations should never crash */
  }
}
