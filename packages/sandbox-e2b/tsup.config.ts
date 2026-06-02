import { defineConfig } from 'tsup';

export default defineConfig({
  // Two entries: the provider surface (`.`) and the CLI surface (`./cli`).
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  dts: true,
  sourcemap: true,
  // commander + @clack/prompts are external (apps/cli bundles them at the root).
  // The `e2b` SDK is bundled by tsup like the other provider deps.
  external: ['commander', '@clack/prompts'],
});
