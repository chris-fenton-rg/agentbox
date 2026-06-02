# E2B provider — build-out backlog

Status tracker for adding **E2B** (`--provider e2b`) as a fifth AgentBox backend,
alongside docker / daytona / hetzner / vercel.

E2B (https://e2b.dev) runs **Firecracker microVMs** with a TypeScript/Python SDK
(`e2b`). Shape-wise it is closest to **Vercel** (microVM per box, SDK comms, no
SSH, public preview hostnames, pause/resume persistence) and **Daytona** (snapshot
tiers). The Vercel provider (`packages/sandbox-vercel/`) is the structural
template for this work; read it first.

## How E2B maps onto the `CloudBackend` abstraction

| AgentBox concept            | E2B primitive |
|-----------------------------|---------------|
| provision a box             | `Sandbox.create(template, { timeout, metadata, envs, ... })` |
| resolve existing box        | `Sandbox.connect(sandboxId)` (auto-resumes if paused) |
| exec                        | `sandbox.commands.run(cmd, { cwd, envs, user, background })` |
| upload / download / ls      | `sandbox.files.write / read / list` |
| preview URL                 | `sandbox.getHost(port)` → `{port}-{sandboxId}.{domain}` (HTTPS) |
| pause / resume              | `sandbox.betaPause()` / `Sandbox.resume(id)` (persistence) |
| list (for prune)            | `Sandbox.list()` (paginator) |
| destroy                     | `sandbox.kill()` |
| session timeout             | `Sandbox.create({ timeout })` (seconds) + `setTimeout` |
| base image (prepare)        | **`e2b template build`** from a Dockerfile — E2B CAN build images from a Dockerfile (key difference from Vercel/Hetzner, which can't) |
| egress policy               | `allow_internet_access` / `network` create opts |
| credentials                 | `E2B_API_KEY` (in `.env.local` and `~/.agentbox/secrets.env`); optionally team id |

### Key open questions — answered in Task 1 (2026-06-02)

1. **Preview URL auth** — **PUBLIC by default.** `sandbox.getHost(port)` returns
   `{port}-{sandboxId}.e2b.app`, served over HTTPS with no token. Smoke-verified
   with a `python3 -m http.server 8080` in-box → host fetch returned HTTP 200
   without any header. Optional gate: `Sandbox.create({ network:
   { allowPublicTraffic: false } })` requires an `e2b-traffic-access-token`
   header (`sandbox.trafficAccessToken`). Task 1 leaves it public to match
   Vercel; revisit in Task 2/3 if the security model warrants gating.
2. **Checkpoint primitive** — **Deferred to Task 2.** E2B's `Sandbox.pause`/
   `Sandbox.connect` (auto-resume) is a single-resume cold-store, not a
   reusable immutable image. The reusable primitive is `Template.build()` from
   a Dockerfile — that lands in Task 2 alongside `agentbox prepare --provider
   e2b`. Task 1 ships a checkpoint stub that throws "not yet implemented for
   e2b (Task 2)".
3. **Privileged ports / port cap** — `getHost(port)` accepts any port; no
   documented cap. Task 1 sets `webProxyPort: 8080` to mirror Vercel and keep
   the in-box `AGENTBOX_WEB_PROXY_PORT` flag uniform across cloud backends.
   Re-test :80 in Task 2.
4. **Nested containers** — **Confirmed `launchDockerd: false`.** E2B is
   Firecracker, same family as Vercel.
5. **Default resources** — E2B `base` template ships node 20, sudo, git, tar
   on Debian 12. vCPU/RAM/disk are **template-level** (`Template.build({
   cpuCount, memoryMB })`), NOT per-create. Task 1's `defaultResources: { cpu:
   2, memory: 4, disk: 8 }` are advisory metadata for BoxRecord stats until
   Task 2's `prepare` bakes a sized custom template.

Additional empirical findings (smoke-tested 2026-06-02):

- **Default user is `user` (uid 1001), not `vscode`.** Task 1's `provision()`
  runs a one-shot in-box fixup script that creates a `vscode` user
  (auto-assigned uid — `1000` is taken by E2B's `code` group on `base`), grants
  passwordless sudo, and chowns `/workspace`, `/run/agentbox`, `/var/log/
  agentbox` so the rest of the cloud scaffold's hardcoded `vscode`
  references work. The vanilla `base` template otherwise has no agentbox-ctl,
  no /workspace, no vscode user.
- **`agentbox-ctl` runs from a single ~835 KB `packages/ctl/dist/bin.cjs`
  bundle.** Task 1 uploads it at create-time via `sb.files.write` (~1s),
  installs to `/usr/local/bin/agentbox-ctl` with `sudo cp+chmod`. No template
  bake needed for Task 1.
- **`Sandbox.getInfo` is the non-resuming static existence check.**
  `Sandbox.connect` auto-resumes a paused sandbox — `state()`/`get()` MUST use
  `getInfo` (not connect) so existence checks don't wake (and bill) a paused
  box. Only ops that need a live handle (exec, files, previewUrl, pause,
  destroy) call connect.
- **`Sandbox.pause` is the canonical pause API** — `betaPause` is deprecated.
- **`sb.commands.run` throws `CommandExitError` on non-zero exit.** The
  CloudBackend contract returns `{exitCode, stdout, stderr}`, so the e2b
  backend catches the error and converts it back to a result.
- **Carry needs the same vercel root carve-out.** Default exec runs as vscode,
  but vscode (uid 1000) cannot `chown` to other uids — the carry chain's
  `chown -R` errors out partway, the parent-chain loop never reaches its
  terminator. `packages/sandbox-cloud/src/carry.ts` now forces `user: 'root'`
  for both vercel AND e2b.

## Task breakdown (each task = one PR, merged before the next starts)

### Task 1 — Package scaffold + `CloudBackend` core  ·  status: DONE 2026-06-02
Goal: `agentbox create --provider e2b` produces a ready box end-to-end,
reusing the `createCloudProvider` scaffold.
- [x] `packages/sandbox-e2b/` package (package.json, tsup, tsconfig). Adds
      `e2b@^2.27.1`.
- [x] `env-loader.ts` + `credentials.ts` — loads/ensures `E2B_API_KEY` from
      `~/.agentbox/secrets.env`; `agentbox e2b login [--status]`.
- [x] `sdk.ts` — re-exports `Sandbox`, resolves the API key, gates with
      actionable error.
- [x] `backend.ts` — every `CloudBackend` method over the E2B SDK
      (provision, get, list, start/stop/pause/resume/destroy, state, exec,
      uploadFile/downloadFile/listFiles, previewUrl, signedPreviewUrl).
      `get`/`state` use `Sandbox.getInfo` (non-resuming) per the orchestrator's
      review; only exec/files/pause/destroy use `Sandbox.connect`.
- [x] `index.ts` — `createCloudProvider(e2bBackend, { defaultResources,
      launchDockerd: false })` + a checkpoint stub that throws
      "not yet implemented for e2b (Task 2)". Exports `e2bProvider`,
      `e2bBackend`, `ensureE2bCredentials`.
- [x] `cli.ts` — `agentbox e2b login [--status]`.
- [x] `runtime-assets.ts` — single-file resolver for `packages/ctl/dist/bin.cjs`,
      uploaded at create-time so the cloud scaffold's `launchCloudCtlDaemon`
      finds `/usr/local/bin/agentbox-ctl`. (Task 2 grows this to a full
      prepared-template bake.)
- [x] `test/env-loader.test.ts` — parser + lookup precedence unit tests.
- [x] Wired into `apps/cli`: `provider/registry.ts`,
      `provider/cloud-backend.ts`, `index.ts`, `help.ts`,
      `commands/{checkpoint,prune,install,prepare,dashboard,fork}.ts`,
      `lib/doctor-checks.ts`, `packages/relay/src/host-actions.ts`,
      `packages/sandbox-cloud/src/carry.ts` (root carve-out for the chown
      walk), `packages/config/src/types.ts` (`ProviderKind` + `box.provider`
      enum), `test/help.test.ts`.
- [x] Smoke: `agentbox create --provider e2b -y -n e2bsmoke -w
      /tmp/e2bsmoke-repo` reaches `box cloud:<id> ready` in ~15s.
      Backend-level smoke (`/tmp/e2b-smoke-checks.mjs`):
        - state → running
        - exec as vscode + as root → exit 0
        - file round-trip (uploadFile / downloadFile) → byte-exact
        - listFiles → `[{name,isDir}]`
        - previewUrl → `https://8080-<sbx>.e2b.app`; HTTP 200 with no token
        - pause → 'paused'; start (connect auto-resume) → 'running'; in-box
          file survives the cycle
        - list → both live sandboxes seen
        - destroy → SandboxNotFoundError on subsequent getInfo (cleanly gone)

### Task 2 — `prepare` (template build) + attach + checkpoints  ·  status: NOT STARTED
- [ ] `prepare.ts` + `prepared-state.ts` — `agentbox prepare --provider e2b`
      bakes the base template via `e2b template build` from a generated
      Dockerfile (reuse the staged docker runtime assets). Record template id in
      `~/.agentbox/e2b-prepared.json`. Base-snapshot gate inside `backend.provision`.
- [ ] `build-attach.ts` — SDK tmux bridge (no SSH; adapt vercel's attach-helper).
- [ ] `checkpoint` capability — resolve open question #2; implement create/list/remove.
- [ ] Smoke: prepare builds a template; pause/resume; checkpoint create + restore
      (`agentbox create --snapshot <ref> --provider e2b`).

### Task 3 — prune + docs + polish  ·  status: NOT STARTED
- [ ] `agentbox prune --provider e2b` (orphan sandbox/template cleanup via `Sandbox.list()`).
- [ ] doctor checks for e2b (credentials, prepared template).
- [ ] Docs: `docs/cloud-providers.md`, `docs/cloud-create-flow.md`, `CLAUDE.md`
      provider list, and the public site `apps/web/content/docs/` (provider page,
      CLI reference, `meta.json`).
- [ ] Final pass on this backlog: mark done vs deferred, note caveats.

## Coordination notes (orchestrator)

- Each task is assigned to an agent via
  `agentbox claude -i "<prompt>" -- --permission-mode=plan` (background box).
  The agent: plans → (orchestrator answers questions from the other providers)
  → implements → smoke-tests → opens a PR → fixes bugbot/CI → merges. Orchestrator
  then pulls `main` and starts the next task.
- `E2B_API_KEY` is in `.env.local` and reachable inside every box; boxes run the
  relay and can launch boxes on other providers, so they can fully smoke-test.

## Changelog
- 2026-06-02: Backlog created; task breakdown + E2B↔CloudBackend mapping drafted.
- 2026-06-02: Task 1 done — package + CloudBackend core, smoke-tested end-to-end.
  Open questions answered (preview URL is public by default; checkpoint deferred
  to Task 2; webProxyPort=8080; no dockerd; resources are template-level).
  Three cloud-scaffold gaps surfaced and fixed here: a Buffer→ArrayBuffer
  conversion for `sb.files.write`, a CommandExitError→CloudExecResult catch,
  and the carry root carve-out extended from vercel to e2b.
