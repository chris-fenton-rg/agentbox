# EXPERIMENT: Adding the `pi` agent harness to AgentBox (+ Colima support)

**Repo:** `chris-fenton-rg/agentbox` (fork of `madarco/agentbox`)
**Date:** 2026-06-22 (Docker + Colima); 2026-06-23 (Daytona, E2B, Hetzner, Vercel cloud)
**Author:** Claude Code (Opus 4.8), driven by chris@rogerhealthcare.com
**Goal:** Fork AgentBox, add the [pi](https://pi.dev/docs/latest) coding agent as a
first-class harness alongside Claude Code / Codex / OpenCode, make it work on
**Colima** (not just Docker Desktop / OrbStack on macOS), prove `agentbox pi`
covers the full AgentBox feature set on local Docker, and extend it to **cloud**
sandboxes — verified end-to-end on **all four cloud providers** (Daytona, E2B,
Hetzner, Vercel), each with a live ChatGPT/openai-codex OAuth turn from the remote
sandbox. See §10 for the cloud results.

---

## 1. Executive summary

`agentbox pi` is implemented and **verified working end-to-end on Colima**. The
harness is a structural peer of `claude` / `codex` / `opencode`: one new CLI
command (`agentbox pi`, with `start` / `attach` subcommands and `download pi`),
one new docker support module, and the corresponding one-line additions across
the core type unions, config, queue, lifecycle, teleport, and status plumbing.

Two findings shaped the result:

1. **Colima needs essentially no dedicated support.** AgentBox already routes
   every Docker operation through the `docker` CLI (inheriting the active
   `DOCKER_CONTEXT`), and `detectEngine()` returns `'other'` for Colima, which
   gracefully bypasses every OrbStack/Docker-Desktop fast path and falls back to
   loopback URLs. The "Docker Desktop + OrbStack only" claim in the upstream
   README is overly conservative. The only Colima-specific change is a
   discoverability fix to the `doctor` hint.

2. **Two pre-existing host-config robustness bugs** in the Claude config sync
   blocked `agentbox create` on this machine (independent of pi/Colima). Both
   are fixed (see §5).

Everything was built and tested against **Docker running via Colima**
(`unix:///Users/chris/.colima/default/docker.sock`, macOS Virtualization.Framework,
virtiofs mounts) with **pi 0.79.10**.

---

## 2. Environment

| Component | Value |
|---|---|
| Host | macOS (Darwin 25.5.0), Apple Silicon (arm64) |
| Container engine | Docker 29.x via **Colima** (not Docker Desktop / OrbStack) |
| Docker context | `colima` (active); `orbstack` + `default` also present |
| pi | `@earendil-works/pi-coding-agent` 0.79.10 (host `/opt/homebrew/bin/pi`) |
| Node | v24.15.0 |
| AgentBox | fork at `~/Code/agentbox`, base `0.18.0` |

---

## 3. Approach

The work was front-loaded with **multi-agent research** (the user explicitly
opted into dynamic workflows / fan-out):

- A **research workflow** (`Workflow` tool) fanned out **5 parallel Sonnet
  workers**, each mapping one layer of the existing harness-integration surface
  using OpenCode/Codex as the template (core+config, CLI commands, docker
  support, session-teleport+ctl-state, cloud+docs+tests), plus **2 external
  research agents** (the pi CLI contract via `pi --help` + docs; Colima
  compatibility via source grep + runtime probes), and a synthesis pass. Result:
  an exhaustive, dependency-ordered file checklist.
- A **Sonnet documentation agent** updated all public + internal docs in
  parallel while the core was implemented.
- The load-bearing core (the new `pi.ts` docker module and `commands/pi.ts`) was
  written directly (correctness-critical), using `codex.ts`/`opencode.ts` as
  templates.

Empirical verification was done live against Colima throughout (build → create →
attach → lifecycle → destroy), per the "verify in the real environment" rule.

---

## 4. Architecture: harness vs. provider

AgentBox cleanly separates two axes:

- **Providers** (the sandbox backend): `docker` (default), `daytona`, `hetzner`,
  `vercel`, `e2b` — one `Provider` interface.
- **Harnesses** (the agent CLI run *inside* a box): `claude-code`, `codex`,
  `opencode` — selected by the top-level command (`agentbox claude` / `codex` /
  `opencode`).

Adding pi is a **harness** change. The harness contract (discovered via the
research workflow) is: an `AgentKind` union member + an `AgentLauncher`
(seed-prompt argv shape); a per-harness docker module providing a config volume
(ensure/sync host→box, mounts+env, runtime install fallback, tmux session
start/attach, session-info probe, config pull-back); a CLI command mirroring
`create`'s surface plus `start`/`attach`; and one-line additions to ~20 union /
registry / switch sites (config, queue, lifecycle list/inspect/destroy/prune,
teleport, status, footer modes, cmux/herdr status labels).

### pi CLI contract (established empirically)

| Aspect | pi |
|---|---|
| Install in a Linux box | `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` (box already has Node 24) |
| Seed prompt | positional arg: `pi "<message>"` (same shape as codex) |
| Config dir | `~/.pi/agent/` (auth.json, settings.json, models.json, extensions/); relocatable via **`PI_CODING_AGENT_DIR`** |
| Auth | per-provider API-key env vars **or** OAuth tokens in `~/.pi/agent/auth.json`. **No interactive `login` subcommand** (unlike codex/opencode) |
| GLM 5.2 | `--model zai-glm/glm-5.2` via a local extension (`~/.pi/agent/extensions/`) + `ZAI_GLM_API_KEY` |
| Sessions | rich native support (`--session-id`, `-c`/`--continue`, `-r`/`--resume`) under `~/.pi/agent/sessions/` |

Design consequence: pi maps onto the **single-config-dir** pattern (like Codex),
not the XDG-split pattern (OpenCode). One volume `agentbox-pi-config` is mounted
at `/home/vscode/.pi`; the host's `~/.pi/agent` is synced into its `agent/`
subdir (so pi's own `~/.pi/cache` stays on the writable volume rather than a
root-owned mount parent). `PI_CODING_AGENT_DIR` pins the config dir.

---

## 5. Colima support

**Finding: no hard blockers.** The research + live testing confirmed:

- All Docker ops go through the `docker` CLI, inheriting `DOCKER_CONTEXT=colima`.
- `detectEngine()` (`host-export.ts`) probes `docker info` and matches only
  `orbstack` / `docker desktop`; Colima falls into the `'other'` branch, so the
  OrbStack `*.orb.local` URLs, `~/OrbStack/...` volume fast-path, and Portless
  OrbStack-skip are all bypassed correctly → Colima gets loopback URLs.
- Runtime-verified on Colima: overlay2 DinD probe works, cgroup v2 + `SYS_ADMIN`
  works, `host.docker.internal` → `host-gateway` resolves, virtiofs `.git`
  bind-mount + in-container worktree work.
- `agentbox doctor` passes cleanly on Colima (docker daemon reachable).

**Change made:** the only Colima gap was *discoverability* — `doctor`'s
"docker not found / not running" hints named only Docker Desktop / OrbStack.
Updated `apps/cli/src/lib/doctor-checks.ts` to also mention Colima
(`brew install colima && colima start`). Docs updated accordingly.

### Robustness fixes (pre-existing, blocked `create` on this machine)

These are **not** Colima- or pi-specific, but blocked `agentbox create` for any
user whose `~/.claude/skills` are absolute symlinks (the standard Superpowers /
plugin layout). Both are in `packages/sandbox-docker/src/claude.ts`:

1. **Absolute skill symlinks.** The helper mounted `~/.agents` only at `/.agents`
   (resolving *relative* `../../.agents/...` links). Absolute links
   (`/Users/<you>/.agents/...`) had no referent inside the helper → rsync exit 23
   → `create` aborted. Fix: also bind-mount `~/.agents` at its **real host path**,
   so both relative and absolute links dereference.

2. **Best-effort config sync.** A reachable symlinked skill dir can contain a
   nested un-dereferenceable link (a Python venv's `bin/python` → host
   interpreter). The pre-scan can't descend into symlinked dirs, so
   `--copy-unsafe-links` still tripped exit 23 and aborted the whole `create`.
   Fix: tolerate rsync exit 23 (partial transfer) for the config seed while
   still running the final `chown`; any other non-zero exit still aborts.

The same exit-23 tolerance is built into the new pi sync from the start.

---

## 6. What was implemented

### New files

| File | Purpose |
|---|---|
| `packages/sandbox-docker/src/pi.ts` | The pi docker harness module: volume resolve/ensure/sync, mounts+`PI_CODING_AGENT_DIR`+forwarded keys, `ensurePiInstalled`, tmux session start/attach, `piSessionInfo`, `pullPiConfig`, `volumeHasPiAuth` |
| `apps/cli/src/commands/pi.ts` | `agentbox pi` (+ `start`, `attach`); mirrors `agentbox opencode` minus the login flow |
| `apps/cli/src/commands/download-pi.ts` | `agentbox download pi` — pull box-side pi config back to host (additive) |
| `apps/cli/src/session-teleport/pi.ts` | v1 teleport stub (friendly error) |
| `packages/sandbox-docker/test/pi.test.ts` | Unit tests (volume resolution, mounts/env, attach argv) — 7 tests |

### Edited (one-line union / registry / switch additions unless noted)

- **Core:** `core/types.ts` (`AgentKind += 'pi'`), `core/agent.ts` (pi
  `AgentLauncher`), `core/box-record.ts` (`piConfigVolume`).
- **Config:** `config/types.ts` — `pi.sessionName`, `box.isolatePiConfig`, the
  `EffectiveConfig`/`BUILT_IN_DEFAULTS` entries, and the config-key registry.
- **Relay:** `relay/queue.ts` — `QueueAgentKind += 'pi'` + active-agent key scan.
- **Docker:** `create.ts` (the `wantPi` block: ensure volume, mounts, env,
  record field), `docker-provider.ts` (`piConfig` plumbing), `index.ts` (exports),
  `lifecycle.ts` (list/inspect `piSession` probe + destroy/prune volume handling),
  `claude.ts` (the two robustness fixes + `formatDetachNotice` 'pi').
- **CLI app:** `index.ts` (register `piCommand`), `help.ts`, `argv-prefix.ts`,
  `wrapped-pty/run.ts` + `footer.ts` (mode `'pi'`), `terminal/cmux-status.ts` +
  `herdr-status.ts` (mode + label), `session-teleport/{types,index}.ts`,
  `lib/agent-answer.ts`, `commands/agent.ts` (`agentKindForSession`),
  `lib/launch-recap.ts`, `lib/queue/assert-creds.ts` (`piAuthAvailable` +
  message), `commands/_run-queued-job.ts` (queue worker dispatch),
  `commands/_cloud-{agent-create,attach}.ts` (mode), `commands/download.ts`,
  `lib/doctor-checks.ts` (Colima hint).
- **Image:** `apps/cli/runtime/docker/Dockerfile.box` — bake pi in (parallel to
  the opencode/codex installs); `ensurePiInstalled` is the runtime fallback for
  images that predate the layer (incl. the published GHCR base, which is the real
  path until upstream republishes).
- **Docs:** `run-an-agent.mdx`, `cli.mdx`, `configuration.mdx`, `index.mdx`,
  `teleport-a-project.mdx`, all four cloud pages (correctly marked Docker-only),
  `README.md`, `docs/features.md`, `docs/test-plan.md`.

Total: **5 new files, ~40 edited files**, `pnpm build` / `pnpm lint` /
`pnpm typecheck` all green (25/25 packages typecheck).

---

## 7. Verification evidence (live, on Colima)

All run against Docker-via-Colima. The box image was built locally on Colima
(`docker build --network=host ...`, 1.15 GB) when the GHCR fingerprint missed.

| Check | Result |
|---|---|
| `agentbox doctor` on Colima | ✅ docker daemon reachable, system OK |
| `agentbox pi --no-attach` (create) | ✅ box created, ctl daemon up, relay registered |
| pi binary in box | ✅ `/usr/bin/pi`, `pi --version` → `0.79.10` |
| pi tmux session | ✅ `pi: 1 windows` running |
| `PI_CODING_AGENT_DIR` | ✅ `/home/vscode/.pi/agent` |
| Host config seeded into box | ✅ `auth.json`, `settings.json`, `models.json`, `extensions/`, `trust.json` (all `vscode`-owned) |
| pi interactive TUI | ✅ full TUI rendered — "Welcome back!", model **GPT-5.5/openai-codex** (from host `settings.json`), 12 extensions, `dir workspace` |
| `agentbox pi attach` (wrapped-pty) | ✅ via `pnpm drive`: pi TUI + AgentBox footer (`Control+a: Actions │ Control+a d: detach`); typed input ("hello pi") reached pi |
| `pause` / `unpause` | ✅ pi session survives |
| `stop` → `pi start` | ✅ box restarts, config re-syncs, pi session relaunches |
| `download pi --dry-run` | ✅ resolves the shared volume, additive logic correct |
| `destroy` | ✅ container + per-box volumes removed; **shared `agentbox-pi-config` preserved** |
| Unit tests | ✅ `pi.test.ts` 7/7 |

### Feature-parity matrix (`agentbox pi` vs. the other harnesses, Docker)

| Feature | Status |
|---|---|
| Create + attach (`agentbox pi`) | ✅ |
| `pi start` / `pi attach` subcommands | ✅ |
| Wrapped-pty footer, detach chord, attach-in modes | ✅ (shared infra) |
| Config volume sync (host → box, shared + `--isolate-pi-config`) | ✅ |
| Runtime install fallback (`ensurePiInstalled`) | ✅ |
| Background `-i` / queue path | ✅ wired (worker dispatch + `piAuthAvailable` gate) |
| pause / unpause / stop / start / destroy / prune | ✅ |
| `download pi` (config pull-back) | ✅ |
| Checkpoints (`--snapshot`, `box.defaultCheckpoint`) | ✅ (provider-level, harness-agnostic) |
| Carry block, from-branch / use-branch, resync, limits | ✅ (inherited from shared create surface) |
| GLM 5.2 | ✅ supported via `agentbox pi -- --model zai-glm/glm-5.2` + host extension/key (carried in) |

---

## 8. Known limitations & follow-ups (v1)

Stated honestly and documented in-repo:

1. **Cloud: all four providers live-validated.** `agentbox pi --provider
   {daytona,e2b,hetzner,vercel}` are each verified end-to-end — `prepare` bake →
   box create → pi runs → a real ChatGPT/openai-codex (OAuth) turn returns the
   expected sentinel from the remote sandbox → stop/start/destroy lifecycle (§10).
   The shared layer (`sandbox-cloud/agent-credentials.ts` AGENT_SPECS + forwarded
   `PI_CODING_AGENT_DIR`, `host-stage.ts` pi stagers, `Dockerfile.box` bake +
   symlink) plus per-provider pieces — `daytona/vercel/hetzner` `prepare.ts`
   staging + `provision.sh`/`install-box.sh` (pi install + creds symlink), and
   `e2b` `build-template.sh` (pi install + creds symlink; e2b stages no agent
   static config, matching codex/opencode). Validation surfaced and fixed three
   real bugs (§10) — none of which the "wired but unverified" state had caught.
2. **Session teleport.** Carrying a *host* pi session into a fresh box
   (`-c`/`--resume`) is a v1 stub (friendly error). pi's own `--continue`/
   `--resume` still work *inside* a box across stop/start (the volume persists
   box-local sessions). A real resolver is feasible (pi has `--session-id`) once
   pi's session-file schema + cwd encoding are pinned.
3. **No ctl activity reporting.** The wrapped-pty footer shows the box name but
   no live pi activity label (working/waiting), because pi has no ctl state
   reporter yet (OpenCode got one via a plugin; Codex via a tmux scraper). The
   session is fully usable; this only affects the live status pill / dashboard.
   A `pi-state` ctl command + a pi extension hook is the parity follow-up.
4. **pi bootstraps its extension packages via npm on first box launch** (a few
   seconds), because the host npm cache is excluded from the sync (it ships
   darwin binaries). Correct for cross-platform; could be sped up with a
   linux-side cache later.
5. **Model/auth is host-derived.** A box uses whatever provider/model the host's
   `~/.pi/agent/settings.json` defaults to (GPT-5.5/openai-codex here) and
   whatever auth is in `auth.json` / forwarded env keys. GLM works only if the
   host has the `zai-glm` extension enabled (it was `.disabled` on this host) or
   a `ZAI_GLM_API_KEY` + models.json provider; the harness faithfully carries
   host state either way.

---

## 9. How to use

```bash
# build the fork CLI
cd ~/Code/agentbox && pnpm install && pnpm build   # or: turbo run build --filter='@madarco/agentbox...'

# Colima must be running (Docker Desktop / OrbStack also fine)
colima start

# create a box + launch pi + attach
node apps/cli/dist/index.js pi -w /path/to/project

# pass args through to pi (e.g. pick a model)
node apps/cli/dist/index.js pi -- --model zai-glm/glm-5.2     # needs ZAI_GLM_API_KEY + the zai-glm extension on the host

# lifecycle (same verbs as every other harness)
node apps/cli/dist/index.js pi start <box>     # relaunch a pi session (resyncs ~/.pi/agent)
node apps/cli/dist/index.js pi attach <box>    # reattach
node apps/cli/dist/index.js download pi <box>  # pull box-side pi config back to host
node apps/cli/dist/index.js destroy <box> -y
```

pi authenticates from forwarded host env keys (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `ZAI_GLM_API_KEY`, ...) or the synced `~/.pi/agent/auth.json`.
There is no `agentbox pi login` (pi has no interactive auth flow).

---

## 10. Cloud sandbox support (Daytona) — implemented + verified

`agentbox pi --provider daytona` works end-to-end. Cloud differs from Docker in
three mechanisms, all now wired for pi:

1. **Binary** — baked into the base snapshot. Daytona builds the base from
   `Dockerfile.box`, so the pi npm-install layer ships in the snapshot
   (`agentbox prepare --provider daytona`). `ensurePiInstalled` remains the
   Docker-side runtime fallback.
2. **Static config** (settings.json / models.json / extensions/) — staged at
   *prepare* time by `stagePiStaticForUpload()` and extracted to
   `/home/vscode/.pi/agent` in the snapshot.
3. **Credentials** (`auth.json`, incl. ChatGPT/openai-codex OAuth) — seeded at
   *create* time into the shared `agentbox-credentials` volume at
   `/home/vscode/.agentbox-creds/pi/`, reached via a baked symlink
   `~/.pi/agent/auth.json → .agentbox-creds/pi/auth.json`. `PI_CODING_AGENT_DIR`
   is forwarded into the sandbox.

### What was implemented
`sandbox-cloud/agent-credentials.ts` (`CloudAgentKind += 'pi'`, AGENT_SPECS +
EXTRACT_SPECS entries, `PI_CODING_AGENT_DIR` + `PI_FORWARDED_ENV_KEYS` in
`buildForwardedEnv`); `host-stage.ts` (`stagePiStaticForUpload` /
`stagePiCredentialsForUpload` + a shared `runRsyncTolerant` that tolerates rsync
exit 23); `claude-credentials.ts` (`PI_CREDENTIALS_BACKUP_FILE`,
`CredentialAgentKind += 'pi'`); `Dockerfile.box` (pi creds symlink + pi bake);
`daytona/prepare.ts` (pi in `stageAllAgentStatic`); `daytona/cli.ts`
(`KNOWN_AGENTS += 'pi'`); `commands/pi.ts` (the `isCloud` branch →
`cloudAgentCreate` / `cloudAgentAttach`, replacing the docker-only guard).

### A real bug this surfaced
The first cloud box came up with **no pi binary** even though codex/opencode were
present. Root cause: `Dockerfile.box` exists in two places — the canonical
`packages/sandbox-docker/Dockerfile.box` and a generated copy at
`apps/cli/runtime/docker/Dockerfile.box` that `scripts/stage-runtime.mjs`
**overwrites from the canonical on every build**. The pi bake had been added to
the *generated* copy and was silently clobbered. Fixed by editing the canonical
file. (Docker never noticed because `ensurePiInstalled` installs pi at runtime.)

### Verification evidence (live, on Daytona)
| Check | Result |
|---|---|
| `agentbox prepare --provider daytona` | ✅ baked `agentbox-base-06af95558570` (11.6 GB, active), pinned in `daytona-prepared.json` |
| `agentbox pi --provider daytona` create | ✅ sandbox provisioned, workspace seeded via git bundle (per-box branch `agentbox/pi-daytona-ws-...`) |
| pi binary in snapshot | ✅ `/usr/bin/pi` 0.79.10 |
| pi config staged | ✅ settings.json (`defaultProvider: openai-codex`), models.json, 13 extensions |
| openai-codex OAuth credential | ✅ `~/.pi/agent/auth.json → .agentbox-creds/pi/auth.json`, seeded (HAS_AUTH) |
| pi tmux session | ✅ running; interactive TUI renders (GPT-5.5 / openai-codex) |
| **Live codex GPT OAuth turn from remote sandbox** | ✅ `pi -p "Reply with exactly: PI_ON_DAYTONA_OK"` → **`PI_ON_DAYTONA_OK`** |

The last row is the headline: a **ChatGPT-subscription OAuth token authenticated
and produced a real model turn from Daytona's remote IP** — the OAuth-from-
remote-IP concern (raised by the codex Keychain/device-auth docs) did **not**
materialize for pi, because pi stores its openai-codex token as a plain file in
`auth.json` (not the macOS Keychain), so it stages cleanly into the sandbox.

### E2B / Hetzner / Vercel — live-validated (2026-06-23)
All three were validated end-to-end with the same bar as Daytona: `prepare` bake
→ box create → pi binary/auth check → a real openai-codex (ChatGPT OAuth) `pi -p`
turn returning the expected sentinel from the remote sandbox → stop/start/destroy.

| Provider | base bake | pi @ node | auth seeded | live turn | lifecycle |
|---|---|---|---|---|---|
| **E2B** | ✅ template `5p3y8c7kct60s429v9zh` | ✅ pi 0.80.1 @ node 24 | ✅ | ✅ `PI_ON_E2B_OK` | ✅ stop/start/destroy |
| **Hetzner** | ✅ snapshot `agentbox-base-mqr4qnag` | ✅ pi 0.80.1 @ node 24 | ✅ | ✅ `PI_ON_HETZNER_OK` | ✅ stop/start/destroy |
| **Vercel** | ✅ snapshot `snap_UsDrrBRLioZlN9F1NEY5UMJChHMu` | ✅ pi 0.80.1 @ node 24 | ✅ | ✅ `PI_ON_VERCEL_OK` | ✅ stop/start/destroy |

They share the generic cloud credential seeding, so `agentbox pi --provider
{e2b,hetzner,vercel}` routes through the same `cloudAgentCreate` path as Daytona,
with no command-layer changes. The **gotcha** from Daytona held throughout: edit
the **canonical** bake scripts under `packages/sandbox-{vercel,hetzner,e2b}/
scripts/`, not the generated `apps/cli/runtime/.../scripts/` copies that
`stage-runtime.mjs` overwrites.

### Three bugs the validation surfaced (none caught by "wired but unverified")
1. **E2B base shipped node 20 → pi crashed on launch.** E2B's base template
   carries a standalone node 20.9.0 at `/usr/local/bin/node`; pi's bundled
   `undici` calls `webidl.util.markAsUncloneable`, which only exists in node
   ≥ 20.18 / 24, so every `pi` invocation died with `TypeError:
   markAsUncloneable is not a function`. Fix: `build-template.sh` now installs
   node 24 **cleanly via NodeSource** (matching the docker + hetzner bases) —
   first removing the standalone node + its stale npm, because merging a newer
   node tarball over `/usr/local` leaves mismatched npm files that break every
   `npm install -g` with `Class extends value undefined is not a constructor`.
   (Hetzner already installed node 24; Vercel's base is node 24 — E2B was the
   only one affected.)
2. **Host pi `extensions/` broke `pi -p` on every static-staging provider.** The
   host's `~/.pi/agent/extensions/*.ts` (TUI/UX customizations + a symlinked
   model shim) were staged into the box and, when they fail to load there, abort
   `pi -p`'s output entirely (empty stdout). Fix: exclude `extensions/` from the
   pi static stage (`PI_RSYNC_EXCLUDES` in `host-stage.ts`) — cloud boxes get
   auth + settings + models, the essentials, and `pi` starts clean. (E2B was
   immune only because it does no static staging; Hetzner exposed it.)
3. **Bloated codex config blew past Vercel's `writeFiles` cap (413) and aborted
   the whole bake.** The codex static stage kept `archived_sessions` (parallel to
   the already-excluded `sessions`) and build artifacts under `~/.codex/skills/*`
   (`target/`, `.venv/`, `node_modules/`) — 2.5 GB, which Vercel's upload rejected
   with a 413 the SDK then choked on as non-JSON, killing the bake before pi could
   stage. Fix: exclude those four in `CODEX_RSYNC_EXCLUDES` (2.5 GB → 71 MB). Not
   pi-specific — it blocks any agent's Vercel bake on a real, long-running host.
