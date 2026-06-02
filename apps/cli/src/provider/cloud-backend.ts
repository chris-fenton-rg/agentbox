/**
 * Lazily resolve a cloud `CloudBackend` by provider name. Dynamic imports keep
 * the heavy provider SDKs (Daytona/Hetzner/Vercel) off the docker hot path.
 * Returns `null` for `docker` (no cloud backend) and any unknown name.
 */
import type { CloudBackend, ProviderName } from '@agentbox/core';

export async function cloudBackendForProvider(
  provider: ProviderName,
): Promise<CloudBackend | null> {
  switch (provider) {
    case 'daytona':
      return (await import('@agentbox/sandbox-daytona')).daytonaBackend;
    case 'hetzner':
      return (await import('@agentbox/sandbox-hetzner')).hetznerBackend;
    case 'vercel':
      return (await import('@agentbox/sandbox-vercel')).vercelBackend;
    case 'e2b':
      return (await import('@agentbox/sandbox-e2b')).e2bBackend;
    default:
      return null;
  }
}
