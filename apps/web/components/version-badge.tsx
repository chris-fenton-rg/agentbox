import { getLatestVersion } from '@/lib/version';

// Version pill for the docs top bar — matches the `.ver` style from the mockup
// (accent green, hairline border, fully rounded). Server Component: the value is
// resolved at request time with hourly ISR (see getLatestVersion).
export async function VersionBadge() {
  const version = await getLatestVersion();
  return (
    <a
      href="https://www.npmjs.com/package/@madarco/agentbox"
      target="_blank"
      rel="noopener"
      className="agb-ver"
      aria-label={`AgentBox version ${version}`}
    >
      v{version}
    </a>
  );
}
