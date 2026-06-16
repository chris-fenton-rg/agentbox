/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // pg runs on the server only and uses dynamic require() internally — keep it
  // external so Next doesn't try to bundle it for the (unused) client.
  serverExternalPackages: ['pg'],
};

export default config;
