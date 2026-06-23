# Repo layout

> Part of the AgentBox docs. Start at [CLAUDE.md](../CLAUDE.md).

```
apps/cli/                   commander-based npm bin (`agentbox`), entry `src/index.ts`
  src/commands/             one file per subcommand. `open` is files-only (Finder; `--path`/`--print` print the host path via `path.ts`'s `runPath`). `url.ts` = top-level `agentbox url` (open the box's web app URL — orb.local/loopback — even with no `expose:`). `screen.ts` = top-level `agentbox screen` (open the noVNC viewer). `path.ts` exports `runPath`, consumed by `open.ts` (no `agentbox path` command). `inspect.ts` exports `runInspect`, consumed by `status.ts` via `agentbox status --inspect` (no standalone `agentbox inspect` command)
  src/help.ts               ordered command groups (HELP_GROUPS) + buildGroupedHelp — tiered top-level `--help` (commander 12 has no native helpGroup; index.ts suppresses the flat list via configureHelp and renders this)
  src/commands/_errors.ts   shared lifecycle-error → user-facing message mapper
packages/core/              @agentbox/core — SandboxProvider interface, BoxState, etc.
packages/sandbox-docker/    @agentbox/sandbox-docker — the local Docker provider
  Dockerfile.box            base:ubuntu + fuse-overlayfs (inner dockerd fallback storage driver) + node + python + tmux + claude (native installer, stable channel) + codex (`npm i -g @openai/codex`) + opencode (`npm i -g opencode-ai`) + pi (`npm i -g --ignore-scripts @earendil-works/pi-coding-agent`) + bundled agentbox-ctl + system-wide `git config safe.directory '*'` + `mkdir /workspace && chown vscode`; NOTE: the published GHCR base predates the pi layer, so `ensurePiInstalled` reinstalls pi at runtime for boxes built from it
  src/create.ts             create orchestrator: image → relay → git-worktrees → snapshot? → volumes → run → mount → verify → ctl daemon → persist
  src/claude.ts             helpers for the named claude-config volume and the in-box tmux session (start/attach/info)
  src/codex.ts              codex parity of claude.ts (trimmed — no plugins): named codex-config volume + in-box tmux session + `codex login` argv + reverse `pullCodexConfig`
  src/opencode.ts           opencode parity of codex.ts: one volume holds OpenCode's two dirs (data at the root, config in a `config/` subdir via `OPENCODE_CONFIG_DIR`) + tmux session + `opencode auth login` argv + reverse `pullOpencodeConfig`
  src/pi.ts                 pi (Earendil `@earendil-works/pi-coding-agent`) parity of opencode.ts: shared `agentbox-pi-config` volume at `/home/vscode/.pi`, rsyncs host `~/.pi/agent` + `PI_CODING_AGENT_DIR` env pin + tmux session + `ensurePiInstalled` runtime fallback (`npm install -g --ignore-scripts @earendil-works/pi-coding-agent`) for boxes from the pre-pi published base + reverse `pullPiConfig`; no `login` subcommand; docker + daytona in v1 (hetzner/vercel/e2b not yet wired)
  src/lifecycle.ts          list/inspect/pause/unpause/stop/start/destroy/prune/open; BoxNotFoundError + AmbiguousBoxError
  src/host-export.ts        per-box host export plumbing (rsync of /workspace into ~/.agentbox/boxes/<id>/workspace)
  src/ctl.ts                launchCtlDaemon — `docker exec -d` the in-box supervisor
  src/relay.ts              ensureRelay (spawns the host relay node process) / registerBoxWithRelay / forgetBoxFromRelay / rehydrateRelayRegistry / generateRelayToken
  src/git-worktree.ts       detectGitRepos / createBoxWorktree / removeBoxWorktree / pickFreshBranch — host-side worktree management
  src/checkpoint.ts         createCheckpoint/listCheckpoints/resolveCheckpointLower — per-project warm-state checkpoints (multi-lower overlay restore)
  src/in-box-git.ts         seedWorkspace (in-container `git worktree add` against bind-mounted .git + stash/untracked replay), seedWorkspaceFromDir (tar pipe for the no-git case), removeInBoxWorktree
  src/{docker,image,snapshot,state}.ts
packages/ctl/               @agentbox/ctl — in-container supervisor + CLI (`agentbox-ctl`)
  src/bin.ts                bundled CJS bin (dist/bin.cjs, baked into the image)
  src/relay-client.ts       fire-and-forget HTTP client the supervisor uses to push state events
  src/commands/git.ts       `agentbox-ctl git pull|push` — routes through the host relay (relay does the actual git op with the user's creds)
  src/commands/checkpoint.ts  `agentbox-ctl checkpoint` — `/rpc checkpoint.create`; relay shells out to the host `agentbox checkpoint create` CLI
  src/{daemon,supervisor,socket,client,config,render}.ts
packages/relay/             @agentbox/relay — host-side HTTP relay (`agentbox-relay`)
  src/bin.ts                bundled CJS bin (dist/bin.cjs); `serve` subcommand is the daemon `ensureRelay` spawns
  src/server.ts             /events, /rpc (git.pull|git.push|checkpoint.create), /admin/* (loopback-only), /healthz
  src/{registry,types,index}.ts
packages/config/            @agentbox/config — host-side layered config (global / per-project / agentbox.yaml `defaults:`)
  src/types.ts              UserConfig, EffectiveConfig, BUILT_IN_DEFAULTS, KEY_REGISTRY (single source of truth)
  src/parse.ts              parseUserConfig (strict) + coerceFromString (CLI input)
  src/paths.ts              findProjectRoot (ancestor walk), hashProjectPath, configPathFor
  src/load.ts               loadEffectiveConfig (merge global+project+workspace+cli with per-leaf source map)
  src/write.ts              setConfigValue / unsetConfigValue (atomic write + meta.json) + listProjectsConfigured
  schema/user-config.schema.json   JSON schema mirrored by `packages/config/test/schema-drift.test.ts`
docs/architecture.md        the design doc — source of truth for *why*
```

**Box identifier resolution** (shared by every lifecycle command that takes `<box>`): `findBox(idOrName, state)` in `state.ts` matches in order: exact id → unique id prefix → exact name → exact container. Ambiguous prefix → `AmbiguousBoxError`; no match → `BoxNotFoundError`. Use `resolveBox()` in `lifecycle.ts` to get a `BoxRecord` from a CLI arg.

**Per-project box index + auto-pick**: each box is stamped at create time with `BoxRecord.projectRoot` (absolute path from `findProjectRoot(workspacePath)` in `@agentbox/config` — nearest ancestor dir holding `agentbox.yaml`, else workspacePath itself) and `BoxRecord.projectIndex` (1-based, monotonic per project, never recycled — `allocateProjectIndex` in `state.ts`). CLI commands take `[box]` as optional and route through `apps/cli/src/box-ref.ts`'s `resolveBoxOrExit`, which delegates to `resolveBoxRef` (`state.ts`): (1) undefined → `autoPickProjectBox` for the cwd's project; (2) pure-numeric ref like `agentbox open 3` resolves against `projectIndex` in the cwd's project and does **not** fall through to id-prefix (so `3` never accidentally matches hex id `3abc…`); (3) non-numeric → existing `findBox`. `agentbox list` renders an `N` column; `agentbox status --inspect` shows `project` + `n`. Pre-feature boxes lack both fields and resolve only by explicit id/name (never auto-picked). `agentbox logs` and `agentbox shell` smart-parse positionals: `agentbox logs <service>` and `agentbox shell -- ls` both auto-pick the box.

Internal deps are wired via `workspace:*`. Build order is enforced by Turborepo (`^build`).
