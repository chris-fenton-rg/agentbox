# Vercel provider — build-out status

Status of the `@agentbox/sandbox-vercel` backend (Vercel Sandbox — Firecracker
microVMs + snapshots). Same `CloudBackend` shape as Daytona/Hetzner, composed by
`@agentbox/sandbox-cloud`'s `createCloudProvider`. Maintained live during
implementation (per the project convention), not as end-of-PR cleanup.

## Why Vercel is shaped differently

- **No custom image.** Vercel Sandbox is Amazon Linux 2023 only; there's no
  Dockerfile build. The base environment is a **Vercel snapshot** baked once by
  `agentbox prepare --provider vercel` (boot fresh node24 → run `provision.sh`
  → `sandbox.snapshot()`), exactly the hetzner-style one-time prerequisite.
- **No nested containers** (validated 2026-05-18, memory
  `project-vercel-sandbox-no-containers`): seccomp blocks `clone`/`unshare`, no
  `CAP_SYS_ADMIN`. The provider sets `launchDockerd: false`; in-box `docker` is
  unavailable by design.
- **No SSH.** `sandbox.domain(port)` is an HTTPS(+WebSocket) proxy only. There's
  no `attachArgv`; attach goes through a custom SDK-streaming helper.
- **Persistent by default.** Stopping a sandbox auto-snapshots; the next
  `Sandbox.get({ resume: true })` resumes from it. That maps cleanly to
  pause/resume — `pause == stop`, `resume == start`.
- **Hard limits:** region `iad1` only, 32 GB fixed ephemeral disk, 2048 MB RAM
  per vCPU (coupled), **≤4 exposed ports** (we use 80 / 6080 / 8788, one free),
  45 min (Hobby) / 5 hr (Pro+) max session.

## Phase status

- [x] **Phase 0 — package scaffold.** `packages/sandbox-vercel` (tsup/tsconfig/
  vitest), `@vercel/sandbox` dep, registry + argv-prefix + CLI registration,
  config `ProviderKind`/`defaultCheckpointVercel`, relay `resolveCloudBackend`.
- [x] **Phase 1 — credentials + SDK loader.** OIDC (`VERCEL_OIDC_TOKEN`) and
  access-token trio (`VERCEL_TOKEN`/`VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID`);
  `agentbox vercel login` + `--status`; env auto-load from
  `~/.agentbox/secrets.env` and `.env.local`.
- [x] **Phase 2 — `CloudBackend`.** provision/get/list/start/stop/pause/resume/
  destroy/state/exec/uploadFile/downloadFile/listFiles/previewUrl/
  signedPreviewUrl + snapshot helpers, all mapped to `@vercel/sandbox` 2.x.
- [x] **Phase 3 — prepare + provision.sh.** Base-snapshot bake with context
  fingerprinting + skip-fast; AL2023 installer (dnf, vscode user, ctl/vnc/shims,
  Claude native installer, codex/opencode).
- [x] **Phase 4 — attach.** `buildVercelAttach` + `attach-helper.js` tmux bridge
  (send-keys / capture-pane pump over the SDK).
- [x] **Phase 5 — checkpoints.** Provider-level `checkpoint` override storing the
  Vercel snapshot **id** in the cloud-checkpoint manifest (Vercel snapshots are
  id-addressed, not name-addressed).
- [x] **Phase 6 — unit tests.** env-loader, credentials, prepared-state,
  backend (mocked SDK), build-attach. `pnpm build && lint && typecheck && test`
  all green.

## What's still missing

The code builds/lints/typechecks and the unit suite (pure, mocked SDK) is green,
but **nothing has been run end-to-end against the real Vercel platform yet** —
both OIDC tokens supplied during development were already expired (the API auth
path was reached, returning 403, which confirms the credential plumbing but not
the runtime behavior). The list below is the actionable backlog, roughly in
priority order.

### P0 — first live smoke pass (needs a non-expired Vercel credential)

These are correctness assumptions that can only be confirmed against the real
platform. Run `agentbox prepare --provider vercel`, then
`create → list → shell → claude → checkpoint → pause → start → destroy`, and
verify each:

1. **`prepare` / `provision.sh` actually completes on AL2023.** dnf package names
   (`tigervnc-server`, `python3-pip`, `libcap`, …), the Claude native installer
   as `vscode`, node24 setcap, corepack — all unverified on a live microVM. The
   snapshot must come back usable.
2. **User mapping.** Default user is `vercel-sandbox`; agentbox standardizes on
   `vscode`. `provision.sh` creates `vscode` (auto uid, no bind mounts so the
   number is irrelevant) + passwordless sudo; `exec` runs `root → sudo -u vscode`;
   `uploadFile` chowns to vscode after `writeFiles` (which writes as
   `vercel-sandbox`). Confirm ownership + that the scaffold's `$HOME`/`$(id -un)`
   resolve to vscode, and that `/workspace` is vscode-owned.
3. **Workspace seed + agent credentials + carry + env-files.** All go through the
   shared cloud scaffold (git bundle/stash/untracked tar upload, `seedAgentVolumesIfFresh`
   fallback, `uploadCarryPaths`, `uploadEnvFiles`) on top of our `uploadFile`/`exec`.
   The `writeFiles`-as-`vercel-sandbox` + chown path is the riskiest unverified
   piece — confirm files land readable/owned correctly under `/workspace` and
   `/home/vscode`.
4. **Relay round-trip.** Confirm the host `CloudBoxPoller` reaches the in-box
   relay over `sandbox.domain(8788)` and that `agentbox-ctl git push|pull` +
   `gh pr` work from inside a vercel box.
5. **Lifecycle semantics.** `pause`→`stop` auto-snapshots; `start`→`get({resume:true})`
   resumes with the same `/workspace`; `destroy` deletes the sandbox AND purges
   its snapshot (no lingering storage charge). Verify preview URLs survive a
   stop/start (they may rotate).
6. **Checkpoint round-trip.** `agentbox checkpoint create` snapshots (stops the
   box; it should auto-resume), the manifest stores the Vercel snapshot id, and a
   later `create --snapshot <ref>` boots from it.

### P1 — known functional gaps

7. **VNC on AL2023.** `tigervnc-server` + `websockify` (pip) + noVNC (git clone)
   install is best-effort. Confirm `agentbox screen` works, or fix the package
   set / `agentbox-vnc-start` for AL2023 (it was written for Debian/Ubuntu).
8. **Attach is laggy.** The `send-keys`/`capture-pane` pump is real but
   higher-latency than a PTY and repaints the whole pane (cursor position not
   preserved). **Upgrade:** a ttyd / WebSocket terminal over `sandbox.domain(port)`
   (WebSocket works through the domain proxy — noVNC relies on it) — needs a ttyd
   binary in the snapshot + a ws client in `attach-helper.ts`, and the 4th port.
9. **Published-CLI asset staging.** `buildVercelAttach` resolves `attach-helper.js`
   next to its own dist (monorepo only); `runtime-assets.ts` resolves `provision.sh`
   + ctl/shims from monorepo paths. The standalone `@madarco/agentbox` bundle needs
   all of these staged into its runtime tree via `apps/cli/scripts/stage-runtime.mjs`
   + a `runtime/vercel/` resolver branch. Until then, `--provider vercel` only works
   from a monorepo checkout, not the published CLI.
10. **Builder cleanup after `prepare`.** We deliberately do NOT `delete()` the
    builder sandbox after `snapshot()` (in case delete cascades to the snapshot).
    Confirm a snapshot survives its source's deletion; if so, delete the builder
    so it isn't left for Vercel's reaper.
11. **OIDC 12h expiry friction.** Dev OIDC tokens last ~12h, so a long `prepare`
    can outlive the token. `resolveCredentials` detects expiry with a clear
    message, but there's no auto-refresh. Document the access-token trio as the
    recommended path for long operations (it doesn't expire on the 12h cycle).
12. **No per-provider resource/region/timeout config.** `vcpus` defaults to 2,
    timeout to 45 min, region is fixed `iad1` (Vercel constraint). The
    "per-provider VM size config" TODO (already tracked in the repo TODO.md)
    should cover vercel `box.vercel.vcpus` / `timeoutMs`.

### P2 — deferred (parity niceties, not blocking)

13. **`agentbox checkpoint list` aggregate view** shows only docker + daytona
    (hetzner is also absent). Add vercel (and hetzner) to the merged list in
    `apps/cli/src/commands/checkpoint.ts`.
14. **Per-project snapshot tier** — the daytona/hetzner `projects[<hash>]`
    optimization that skips workspace/credential re-seeding on repeat creates for
    the same project. `prepared-state.ts` is single-tier (base only) today.
15. **`agentbox prune --provider vercel`** — the backend `list()` works; the
    prune command branch isn't wired.
16. **`Sandbox.fork()`** as a faster "branch from a running box" primitive than
    snapshot + create (Vercel-native, no host round-trip).
17. **4th port / per-service `expose`.** Only 3 of the 4 allowed ports are used
    (80/6080/8788); per-service `expose` URLs from `agentbox.yaml` beyond the
    WebProxy aren't surfaced (the scaffold tries, but we're near the port cap).
18. **`networkPolicy` / `extendTimeout`** are unused — could expose egress
    locking (a safety win, cf. the hetzner firewall) and longer single sessions.
