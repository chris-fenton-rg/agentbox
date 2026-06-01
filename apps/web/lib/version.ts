import fallback from './version-fallback.json';

const NPM_LATEST = 'https://registry.npmjs.org/@madarco/agentbox/latest';

/**
 * Latest published AgentBox version. Fetches the npm registry with hourly ISR;
 * on any failure falls back to the version snapshotted from apps/cli/package.json
 * at build time, so the badge is never empty or offline-broken.
 */
export async function getLatestVersion(): Promise<string> {
  try {
    const res = await fetch(NPM_LATEST, { next: { revalidate: 3600 } });
    if (!res.ok) return fallback.version;
    const data = (await res.json()) as { version?: string };
    return data.version ?? fallback.version;
  } catch {
    return fallback.version;
  }
}
