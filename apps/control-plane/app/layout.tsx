import type { ReactNode } from 'react';

export const metadata = {
  title: 'AgentBox control plane',
  description: 'Boxes, approvals, and events across machines',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
          background: '#0c0d10',
          color: '#e6e6e6',
          fontSize: 14,
        }}
      >
        {children}
      </body>
    </html>
  );
}
