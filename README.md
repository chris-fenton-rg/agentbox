# AgentBox

Launch Claude Code, Codex, and other coding agents inside isolated sandboxes — local Docker today, remote providers (E2B / Modal / Daytona / Vercel Sandbox) later.

**Status:** early work in progress. See [`docs/architecture.md`](./docs/architecture.md) for the design.

## Layout

```
apps/cli/                 → published as `agentbox` (the npm bin)
packages/core/            → @agentbox/core — types and lifecycle interfaces
packages/sandbox-docker/  → @agentbox/sandbox-docker — local Docker provider
```

Remote sandbox adapters (E2B, Modal, Daytona, Vercel Sandbox) will be added as separate packages.

## Development

Requires Node `>=20.10` and pnpm `>=9`.

```sh
pnpm install
pnpm build       # build all packages
pnpm test        # run vitest across the workspace
pnpm lint        # eslint
pnpm typecheck   # tsc --noEmit per package
```

After `pnpm build`, you can run the CLI from the workspace:

```sh
pnpm --filter agentbox exec agentbox --help
```
