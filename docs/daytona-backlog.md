# Daytona Cloud Provider — Backlog

The full 6-phase plan lives at `~/.claude/plans/synthetic-jumping-flame.md`. This file tracks **what's still missing** after the foundation + comms + Daytona backend + Phase 3 routing all landed and were e2e-verified against a real Daytona sandbox.

Status legend:
- 🔴 **blocking** — cloud users hit this often / no workaround.
- 🟡 **friction** — has a workaround; smooths UX when fixed.
- 🟢 **polish** — nice-to-have / cleanup / aesthetics.

---

## 1. Sandbox seeding & agent config (Phase 6 core)

### 1.1 🔴 `envFilesToImport` not uploaded to cloud sandboxes
The setup wizard collects host env/config files (`.env`, `secrets.toml`, `agentbox.yaml`, …) and `--with-env` works for Docker. **The cloud provider's `create()` drops them entirely** — the user picks files in the wizard but they never land in the sandbox.

**Fix:** in `packages/sandbox-cloud/src/cloud-provider.ts` `create()`, after workspace seeding, build a tar of `req.envFilesToImport` (workspace-relative paths) → `backend.uploadFile(tar, '/tmp/envfiles.tar')` → `backend.exec(... tar -xf ... -C /workspace)`. Mirror the `copyHostEnvFilesToBox` logic from `packages/sandbox-docker/src/host-export.ts`.

### 1.2 🔴 Claude / Codex / OpenCode credentials not synced to cloud
Docker boxes get host `~/.claude`, `~/.codex`, `~/.config/opencode` rsync'd into named volumes at create (filtered for host-only hooks, plugin native deps, etc — see `packages/sandbox-docker/src/claude.ts` / `codex.ts` / `opencode.ts`). **Cloud boxes get nothing** — the user must `claude login` / `codex auth login` / `opencode auth login` interactively inside every new sandbox.

**Fix:** extract the host-side filtering ("what to sync") from `claude.ts` / `codex.ts` / `opencode.ts` into provider-neutral helpers in `@agentbox/sandbox-core/agent-config/`. Cloud impl: stage the filtered tree to a host tmpdir, tar, upload via `backend.uploadFile`, extract into the right HOME paths. Handle the `_claude.json` write-once rule across sandbox restarts.

### 1.3 🟡 Workspace bundle is full-history `--all`
`packages/sandbox-cloud/src/workspace-seed.ts` does `git bundle create --all`, which is fine for small repos but slow + big upload for monorepos with deep history.

**Fix:** add a depth knob (`AGENTBOX_BUNDLE_DEPTH` env or config key); default to full history, allow `--depth N` for shallow seeding.

### 1.4 🟡 Nested-repo monorepos not seeded
`workspace-seed.ts` v0 only handles the root repo (`detectGitRepos(...).find(r => r.kind === 'root')`). Nested submodules / monorepo with multiple `.git` dirs are silently skipped.

**Fix:** iterate `detectGitRepos` results; bundle + clone each at the right `/workspace/<rel>` path. Matches the docker `seedWorkspace` semantics.

### 1.5 🟡 Host uncommitted changes carry-over not implemented
Docker provider runs `git stash create` + tar of untracked files so the in-box workspace starts with the user's local-but-unstaged state. Cloud `seedFromGitBundle` skips this — the sandbox starts from the last committed tip of every branch.

**Fix:** mirror `collectRepoCarryOver` from `packages/sandbox-docker/src/in-box-git.ts`; fold the stash commit into the bundle and tar the untracked files alongside.

---

## 2. Host executor & comms layer (Phase 4 polish)

### 2.1 🔴 `cp.toHost` / `cp.fromHost` cloud executor is a stub
`packages/relay/src/host-actions.ts` `executeCloudAction` only handles `git.push` / `git.fetch`. `cp.*` falls into the default branch and returns `"host executor for 'cp.toHost' is not yet supported for cloud boxes"`. The in-box `agentbox-ctl cp …` call unblocks cleanly but the user can't move files.

**Fix:** implement `cp.toHost` (sandbox → host) via `backend.downloadFile`; `cp.fromHost` (host → sandbox) via `backend.uploadFile`. Reuse the existing `askPrompt` gating like Docker does.

### 2.2 🔴 `download.workspace` / `download.env` / `download.config` / `download.claude` cloud executor stubbed
Same as 2.1 — the bridge plumbing parks them but no executor handles them. The Docker provider shells out to the CLI's `download` subcommands; for cloud we'd need to mirror that with `backend.downloadFile` + rsync semantics.

### 2.3 🟡 `checkpoint.create` cloud executor stubbed
v1 deferred checkpoints for cloud (Daytona can't snapshot a live sandbox's FS). For long-term: implement via `sb.archive()` + naming, or via image rebuild. Until then the in-box `agentbox-ctl checkpoint` returns "not yet supported".

### 2.4 🟡 `askPrompt` host-confirm gate needs SSE mirror for cloud `git.push`
`executeCloudAction` calls `askPrompt(deps.prompts, deps.subscribers, …)` for `git.push`. This pushes the prompt event on the host relay's `subscribers` (PromptSubscribers) — only consumed by an *attached* `agentbox claude` wrapper via `/admin/prompts/stream` SSE. If no wrapper is attached and `AGENTBOX_PROMPT` ≠ `'off'`, the executor blocks indefinitely waiting for an answer.

**Fix options:**
- Add a `--auto-yes-git-push` config for cloud boxes that don't have an attached wrapper.
- Or: have the cloud-poller's askPrompt include a ttl + default-deny when no subscribers are present.
- Or: route the prompt to a desktop notification / browser tab when no terminal is attached.

### 2.5 🟢 `browser.open` host-mirror offer for cloud
Cloud box's `agentbox-ctl open <url>` is currently handled at the in-sandbox relay (records event, returns 200 immediately). The "open on host too?" offer that Docker shows is not mirrored for cloud — would need the same SSE bridge as 2.4.

### 2.6 🟢 Host poller: long-poll vs Daytona proxy idle cap
The `CloudBoxPoller` holds `/bridge/poll` up to ~25s. Daytona's CloudFront edge sometimes 504s mid-poll (observed during e2e testing). Add a backoff + faster-cycle fallback after a 504.

---

## 3. CLI routing (Phase 3 polish)

### 3.1 🔴 Default `agentbox claude` / `codex` / `opencode` actions are Docker-only
These commands' default action (`agentbox claude` with no subcommand) creates a fresh **Docker** box and attaches. They don't have a `--provider` option; the `<name>` positional is passed as args to the agent (not as a box ref). So `agentbox claude my-cloud-box` makes a *new docker box*, doesn't attach to `my-cloud-box`.

**Workaround today:** `agentbox create --provider daytona -n my-cloud-box` then `agentbox claude attach my-cloud-box` (the attach subcommand IS cloud-aware via `cloudAgentAttach`).

**Fix:** add `--provider <name>` to claudeCommand / codexCommand / opencodeCommand defaults; when set to a cloud provider, route through `providerForCreate` + `cloudAgentAttach`. Currently this is partially handled by `agentbox create --provider daytona` running the wizard which can auto-attach claude post-create, but a direct `agentbox claude --provider daytona` would be cleaner.

### 3.2 🟡 Extra agent args after `--` dropped for cloud
`cloudAgentAttach` warns and ignores `claudeArgs`/`codexArgs`/`opencodeArgs` because 3-layer shell escaping (SSH → tmux → bash) is fiddly. Users who need `--model sonnet` or similar must attach plain and pass them inside the agent's TUI.

**Fix:** properly escape the args through all three layers. Likely via a heredoc or base64-encoded launcher script.

### 3.3 🟡 `agentbox shell` cloud path doesn't support `--name <label>` / `--new` shell session management
The Docker shell command has multi-session support (named shells, attach-by-label). The cloud branch uses a single fixed `sessionName: 'shell'` tmux session.

**Fix:** route session naming + `--new` through `BuildAttachOptions.sessionName`; mirror docker's `allocateShellSessionName` / `listShellSessions` semantics for cloud using `tmux ls` over SSH.

### 3.4 🟡 `agentbox cp` / `download` cloud-guarded
Currently `requireDockerProvider(box, 'cp')` / `'download'` bails with a clear message. Need to route through `provider.uploadPath` / `downloadPath` (cloud impl already exists conceptually but isn't wired in commands).

### 3.5 🟡 `agentbox logs` cloud-guarded
For cloud could run `backend.exec("tail -F /var/log/agentbox/<service>.log")` via the SSH attach machinery. Same shape as `agentbox shell` one-shot.

### 3.6 🟡 `agentbox screen` (noVNC) cloud-guarded
The VNC daemon does run inside the cloud sandbox (Dockerfile.box bakes it). Need to resolve `backend.previewUrl(6080)` and open it; same pattern as `agentbox url` but on a different port.

### 3.7 🟡 `agentbox wait` cloud-guarded
Could route via `provider.exec(box, ['agentbox-ctl', 'wait-ready', '--json', ...])` and parse the same `WaitReadyReply`.

### 3.8 🟢 `agentbox code` (VS Code attach) cloud-guarded
VS Code Remote-SSH could connect to the Daytona sandbox using the same SSH token machinery. Build a `vscode://vscode-remote/ssh-remote+<token>@ssh.app.daytona.io/workspace` URI.

### 3.9 🟢 `agentbox open` cloud-guarded
"Open box's /workspace in Finder" doesn't really map to cloud — the workspace is in the sandbox, not on host disk. Could rsync it down on demand, but probably leave guarded.

### 3.10 🟢 `agentbox top` filters cloud boxes
Today `listBoxes`-style aggregation in top.ts filters out cloud entries. Live stats for cloud would need `backend`-level metrics (Daytona SDK doesn't seem to expose CPU/mem stats directly). Defer.

### 3.11 🟢 `agentbox dashboard` cloud-guarded
The TUI dashboard polls live stats + claude state. Could work with the persisted status snapshot we already mirror, but the live panels (tmux capture etc.) don't have a cloud path.

### 3.12 🟢 `agentbox checkpoint` / `prune` / `update` Docker-only by design
Plan deferred these for cloud v1. Checkpoint depends on cloud snapshot semantics (Daytona's `sb.archive()` is the closest); prune/update are docker-image lifecycle ops. Leave guarded.

---

## 4. URL / browser UX

### 4.1 🔴 `agentbox url <cloud-box>` opens a URL the browser rejects
Daytona's preview proxy requires the `x-daytona-preview-token` header for every request. Browsers can't add custom headers from a URL; `agentbox url` opens the bare URL which immediately 401s.

**Fix:** either (a) make the cloud box's web preview `public: true` at provision (security tradeoff — anyone with the URL can hit the app); (b) attach the token as a `?token=…` query parameter if Daytona's proxy accepts it; (c) generate a signed URL via the Daytona API (if it exists); (d) ship a tiny localhost helper that proxies host requests through the token. **Document the current limitation prominently** until one of these is wired.

### 4.2 🟡 `getBoxEndpoints` for cloud doesn't include service ports
Cloud box's `cloud.previewUrls` only carries port 80/8080 today. Per-service `expose:` ports declared in `agentbox.yaml` could each get a preview URL (call `backend.previewUrl(port)` at create+start for every declared port).

---

## 5. Image / provisioning

### 5.1 🟡 First-time Dockerfile.box snapshot build takes ~7 min on Daytona
41 layers including Playwright + Chrome download. Acceptable for first run, but `agentbox create --provider daytona` from a fresh org/user feels slow. Considered: publish a pre-built snapshot to a public Daytona snapshot registry; default to it; fall back to `Image.fromDockerfile` for users who want to rebuild.

### 5.2 🟢 No DinD verification for cloud
The Daytona DinD PoC validated `dockerd` runs inside a Daytona sandbox, but our cloud provider doesn't launch `dockerd` (`packages/sandbox-docker/src/dockerd.ts` is Docker-only). The Dockerfile.box installs `docker.io` so a cloud user could `dockerd &` manually, but `agentbox`-driven in-box docker isn't wired.

### 5.3 🟢 In-sandbox `agentbox-ctl daemon` log isn't surfaced
Lives at `/var/log/agentbox/ctl-daemon.log` inside the sandbox. No CLI command pulls it. Should be reachable via `agentbox logs --daemon <cloud-box>` once `logs` routes for cloud (3.5).

---

## 6. Operational / robustness

### 6.1 🔴 Daytona 504s from CloudFront mid-call
The Daytona SDK's `executeCommand` and other API calls intermittently 504 from Daytona's CloudFront edge. Observed multiple times during e2e testing. **No retry logic** in `packages/sandbox-daytona/src/backend.ts`.

**Fix:** wrap each backend method in a small retry-with-backoff (3 attempts, 1s/2s/4s) for 5xx responses. Don't retry on 4xx (auth / not-found).

### 6.2 🟡 `agentbox destroy` for cloud leaves the Daytona dashboard showing the sandbox for ~30s
`sb.delete()` is queued; the API reports `not found` immediately but the dashboard polls slowly. Our `stop` → `delete` sequence makes the actual deletion sync, but the dashboard lag is cosmetic.

**Fix:** none from our side — Daytona consistency window. Document.

### 6.3 🟡 Smoke-test orphan sandboxes left behind on harness timeouts
If a test (or interactive create) is killed mid-provision before `recordBox` completes, the half-provisioned Daytona sandbox lingers (the `catch` block's `backend.destroy` only runs if Node gets to handle the exception). Add a periodic cleanup helper (`agentbox prune --provider daytona` would list orphans + offer to delete).

### 6.4 🟢 Relay rehydrate on restart re-runs every previously-parked action
After `agentbox relay restart`, the host poller drains stale actions from the in-sandbox `HostActionQueue` and re-executes them — including old `git.push` attempts the user has long forgotten. Add a "max age" on queued actions so anything older than ~15 min is discarded instead of executed.

---

## 7. Architecture / cleanup

### 7.1 🟡 `BoxRecord.docker?:` nesting cleanup
Per the plan's §3 deferred cleanup, Docker-specific fields (`container`, `image`, `*Volume`, `webHostPort`, `portlessAlias`, …) still live flat on `BoxRecord` for back-compat. Nesting them under `box.docker?:` (paralleling `box.cloud?:`) would make the discriminator clean.

**Risk:** ~30 call sites touch the flat fields; sweep + state-file migration on read.

### 7.2 🟡 `containerName` on cloud `BoxRecord` is synthetic
Cloud boxes set `container: 'agentbox-cloud-<id>'` to satisfy the (still-required) `BoxRecord.container` field. Anything that grep/inspects container names sees this; `agentbox-cloud-*` should never appear in `docker ps` output. Cleaner once 7.1 lands.

### 7.3 🟡 `@agentbox/relay` → `@agentbox/sandbox-daytona` is a runtime dep with no package.json declaration
The relay uses `await import('@agentbox/sandbox-' + 'daytona')` to defeat esbuild's static resolution (avoiding a sandbox-daytona → sandbox-cloud → sandbox-docker → relay cycle). Runtime resolution depends on the parent CLI's `node_modules`. Works in dev (pnpm symlinks) and when the published `agent-box` package has `@agentbox/sandbox-daytona` as a dep (it does), but it's a fragile contract — document or formalize as a peerDependency.

### 7.4 🟢 Multiple cloud backends (Vercel, …) when needed
The `CloudBackend` interface is provider-neutral; adding a new backend means a new `packages/sandbox-<name>` with `~150` lines + a string case in `resolveCloudBackend`. No design changes needed.

---

## 8. Docs

### 8.1 🔴 README + `docs/architecture.md` don't mention cloud
Plan called out updating `docs/architecture.md`, `docs/host-relay.md`, `docs/state.md`, `docs/features.md`, and adding `docs/cloud-providers.md`. Currently the docs all describe the Docker-only world.

### 8.2 🟡 Daytona setup quickstart missing
No guide for: get DAYTONA_API_KEY → put it in `~/.agentbox/secrets.env` → `agentbox create --provider daytona`. The error message in `backend.ts` covers it but a 10-line walkthrough would be nicer.

### 8.3 🟡 CLAUDE.md doesn't mention the cloud path
Project's `CLAUDE.md` describes the Docker box model. Should mention `--provider daytona` and link to this backlog + `docs/cloud-providers.md` (8.1).

---

## 9. Testing

### 9.1 🟡 No automated cloud E2E test
All cloud verification has been manual via the Daytona API. A scripted test in `apps/cli/test/cloud-e2e.test.ts` that does create → ssh shell → destroy (requires `DAYTONA_API_KEY` + `DAYTONA_ORGANIZATION_ID` in env) would catch regressions.

### 9.2 🟡 No unit tests for cloud-cloud
`packages/sandbox-cloud/test/shell.test.ts` covers shell quoting. Nothing tests `cloud-provider.ts` `buildAttach` / `createCloudProvider` composition, `workspace-seed.ts` script construction, or `ctl-launch.ts`. Worth a mock-backend test.

### 9.3 🟡 No unit tests for `host-actions.ts`
The git-bundle pull-back logic is e2e-tested but lacks unit coverage. A mock `CloudBackend` would make this testable.

### 9.4 🟢 Interactive flows (claude / shell PTY) only manually verifiable
Hard to fully test without a real TTY; rely on the smoke `agentbox shell <box> -- <cmd>` non-TTY path which exercises the SSH + exec + env code paths.

---

## Quick-win order (suggested)

1. **6.1 Retry-on-504** — smallest, fixes a real flakiness everyone sees.
2. **1.1 envFilesToImport upload for cloud** — wizard collects them but throws them away; easy win.
3. **4.1 URL token UX** — `agentbox url` for cloud currently 401s in browser; needs at least clear documentation + ideally a query-param attempt.
4. **3.1 `--provider` on `agentbox claude/codex/opencode` default actions** — the most-confusing UX gap (`agentbox claude my-cloud-box` silently creates a docker box).
5. **1.2 Agent-config sync** — biggest UX leap (no more in-box `claude login`).
6. **2.1 / 2.2 cp + download cloud executors** — unblocks the `agentbox-ctl cp/download` workflows.
