// Build/dev prestep:
//  1. Copies the JSON schemas the docs link to into public/schema/.
//     (Replaces the schema-copy step that used to live in the old vercel.json buildCommand.)
//  2. Snapshots the published CLI version from apps/cli/package.json into
//     lib/version-fallback.json — the offline fallback for the version badge when
//     the npm registry fetch fails. apps/cli/package.json stays the source of truth.
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const repoRoot = resolve(root, '..', '..');

const schemas = [
  ['packages/ctl/schema/agentbox.schema.json', 'public/schema/agentbox.schema.json'],
  ['packages/config/schema/user-config.schema.json', 'public/schema/user-config.schema.json'],
];

await mkdir(resolve(root, 'public/schema'), { recursive: true });
for (const [from, to] of schemas) {
  await copyFile(resolve(repoRoot, from), resolve(root, to));
  console.log(`copied ${from} -> ${to}`);
}

const cliPkg = JSON.parse(await readFile(resolve(repoRoot, 'apps/cli/package.json'), 'utf8'));
await writeFile(
  resolve(root, 'lib/version-fallback.json'),
  JSON.stringify({ version: cliPkg.version }, null, 2) + '\n',
);
console.log(`version-fallback -> ${cliPkg.version}`);
