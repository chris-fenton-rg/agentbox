import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  async rewrites() {
    return {
      beforeFiles: [
        // The marketing page (public/home.html) is the site root, served as-is
        // so its inline scripts (animated terminal, diagram) keep working.
        { source: '/', destination: '/home.html' },
        // The marketing markup references assets with a literal `/public/` prefix
        // (legacy of the old static-site layout). Map them to Next's public root.
        { source: '/public/:path*', destination: '/:path*' },
      ],
    };
  },
};

export default withMDX(config);
