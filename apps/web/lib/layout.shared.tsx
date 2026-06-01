import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { VersionBadge } from '@/components/version-badge';

// Shared nav config for the docs layout. The brand mark + `/ docs` tag and the
// version pill mirror the top bar from the AgentBox Docs design mockup.
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="" className="agb-logo" width={20} height={20} />
          <span className="agb-brand">agentbox</span>
          <span className="agb-tag">/ docs</span>
        </>
      ),
    },
    githubUrl: 'https://github.com/madarco/agentbox',
    // Search trigger is rendered in the sidebar (see app/docs/layout.tsx), not the navbar.
    searchToggle: { enabled: false },
    links: [
      {
        type: 'custom',
        secondary: true,
        children: <VersionBadge />,
      },
    ],
  };
}
