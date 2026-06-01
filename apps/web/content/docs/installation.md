---
title: Install
description: Install the AgentBox CLI and run your first sandboxed agent.
---

AgentBox ships as a single npm CLI. Install it globally, then let it teleport
your project into an isolated box and launch a coding agent inside it.

## Requirements

- **OS** — macOS (arm64 or Intel) or Linux.
- **Docker** — [Docker Desktop](https://www.docker.com/products/docker-desktop/)
  or [OrbStack](https://orbstack.dev/). Required for the default local provider.
- **Node** — `>=20.10`.

The first `agentbox create` / `agentbox claude` builds the `agentbox/box:dev`
image (~1&nbsp;GB, one-time). AgentBox uses `portless` to give box web apps the
same URL inside the box and on the host.

## Install the CLI

```sh
npm -g install @madarco/agentbox
```

## First run

Install the host integration, then launch a box with Claude Code — AgentBox
copies your settings and workspace into a fresh VM:

```sh
agentbox install

# Launch a new box with claude, carrying your settings + workspace
agentbox claude
```

On first launch AgentBox offers to set up the project for you:

```text
> Run setup wizard? -> Yes
```

Answer **Yes** to install the project's libraries and start its dev server
inside the box.

## Run a different agent

The same flow works for Codex and OpenCode — swap the subcommand:

```sh
agentbox codex
agentbox opencode
```

You can also run a box without installing globally:

```sh
npx @madarco/agentbox claude
```

## Next steps

- Run agents on a cloud provider instead of local Docker — Daytona, Hetzner, or
  Vercel. (Provider guides coming soon.)
- Explore the full command surface: `create`, `attach`, `shell`, checkpoints,
  and safe `git push` through the host relay.
