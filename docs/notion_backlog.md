# Notion integration + shared foundation — backlog

Live tracker for building the **Notion** integration and the **shared
`integrations` foundation** described in [`integrations_backlog.md`](./integrations_backlog.md).
Each task is one box → one PR into the `add-ticketing-integrations` feature
branch. Boxes work **sequentially**: each branches off the latest feature-branch
HEAD *after* the previous task merges (PRs stack cleanly, no conflicts).

## Model recap (why this shape)

Mirror the `gh` relay model exactly: in-box `notion` shim → `agentbox-ctl
integration notion <op>` → host relay → host's authenticated `ntn` CLI. Writes
gated by `askPrompt`; reads pass through; **the box never holds a Notion token**.
The host relay runs the host's `ntn` (keychain auth on macOS). For nested-box
e2e, `ntn` creds are carried into the box as **file-based auth**
(`NOTION_KEYRING=0` → `~/.config/notion/auth.json`); the connector forces
`NOTION_KEYRING=0` when shelling out so it works on Linux boxes.

Reference implementations to copy: `packages/relay/src/gh.ts`,
`packages/ctl/src/commands/gh.ts`, `packages/sandbox-docker/scripts/gh-shim`,
`packages/relay/src/prompts.ts`, `packages/relay/src/host-initiated.ts`.

## Per-box workflow (every task)

1. **Plan first** — enter plan mode, produce a concrete plan, get it approved.
2. **Implement** on a branch off the current feature-branch HEAD.
3. **Verify** — `pnpm typecheck`, `pnpm test`, `pnpm build`, plus the task's
   own verification (unit tests + a real `agentbox-ctl integration notion …`
   round-trip where applicable). Verify ground truth, not exit codes.
4. **`/review high`** then **`/simplify`** — apply findings.
5. **File a PR** into `add-ticketing-integrations` (not `main`).
6. **Fix bugbot** comments on the PR until clean.
7. **Merge**, then the orchestrator moves to the next task in a fresh box.

## Tasks

### T1 — Shared foundation + Notion core plumbing  ✅ done
The working vertical slice: `agentbox-ctl integration notion <op>` round-trips
through the relay to host `ntn`, with read/write classification + write gating.
- `packages/integrations/` package: `types.ts` (IntegrationOp, IntegrationConnector),
  `registry.ts` (getConnector, ALL_CONNECTORS), `connectors/notion.ts`.
  - Notion ops (start minimal, allowlist-only): **read** `api` (GET passthrough,
    e.g. `ntn api v1/search`, `ntn api v1/pages/<id>`); **write** `page.create`,
    `page.update` (archive/props), `comment.add` — all gated.
- `packages/relay/src/integrations.ts`: `runHostIntegration`,
  `assertIntegrationReady`, generic `integration.<svc>.<op>` dispatch (reuse
  `askPrompt` + `HostInitiatedTokens`). Connector forces `NOTION_KEYRING=0` env.
- Wire dispatch into **both** `packages/relay/src/server.ts` (`POST /rpc`) and
  `packages/relay/src/host-actions.ts` (cloud path — "fix across all providers").
- `packages/ctl/src/commands/integration.ts` (built from descriptors) + register
  in the ctl entrypoint next to `ghCommand`.
- Unit tests: op read/write classification; allowlist denies unknown ops;
  dispatch gates writes (askPrompt called) and not reads; denied → exit 10.

### T2 — In-box `notion` shim + image provisioning + config flags  ✅ done
Make a box agent able to type `notion …` or `ntn …`.
- `packages/sandbox-docker/scripts/ntn-shim` (gh-shim pattern: strict
  subcommand allowlist → `agentbox-ctl integration notion <op> -- "$@"`).
  Installed on PATH as `/usr/local/bin/ntn`; `/usr/local/bin/notion` is a
  symlink to it. Same shim for both invocations.
- Staged: `contextFiles` + `execBitFiles` in `apps/cli/scripts/stage-runtime.mjs`
  plus the `hetznerFiles` / `vercelFiles` / `e2bFiles` lists; COPY'd in
  `Dockerfile.box` next to the `gh-shim`/`git-shim` COPY; mirrored into
  `packages/sandbox-hetzner/scripts/install-box.sh`,
  `packages/sandbox-vercel/scripts/provision.sh`, and
  `packages/sandbox-e2b/scripts/build-template.sh` (plus each provider's
  `src/runtime-assets.ts` so the staged file gets uploaded). Daytona stays
  shim-less (matches its T1 gh/git decision).
- Config: added `integrations.notion.enabled` (default **false**) to
  `packages/config/src/types.ts` — `UserConfig`, `EffectiveConfig`,
  `BUILT_IN_DEFAULTS`, and `KEY_REGISTRY`. Parser/merger/writer were taught
  to walk 3-level nested keys (`branch.subbranch.leaf`) so the YAML stays
  natural. Set with `agentbox config set --project integrations.notion.enabled true`.
- Gate placement: the **relay** (`refuseIfIntegrationDisabled` in
  `packages/relay/src/integrations.ts`, wired into BOTH
  `handleIntegrationRpc` in `server.ts` (docker) and `runIntegrationRpc`
  in `host-actions.ts` (cloud — daytona/hetzner/vercel/e2b) per the
  "fix across all providers" rule). One check covers every caller
  (shim / `notion` alias / direct `agentbox-ctl integration` / future
  host-initiated tokens) and re-reads the layered config per call so a
  flag flip takes effect without bouncing the relay (same approach as
  `loadAutopauseConfig`). Disabled → exit 65 with a `agentbox config set …`
  hint; no host process is touched.
- Connector cleanup (minimal): the T1 `comment.add` op is **dropped**.
  `ntn` exposes no top-level `comment` subcommand — the only host path
  would be `ntn api v1/comments -X POST -f …`, which the T1 `api` op
  refuses (GET-only). The op also had no callers (T1 just merged, no shim
  yet), so a forward-only drop is cleaner than carrying dead surface
  through. The shim refuses `notion comment add …` with a clear
  "deferred from T2" message; comments are tracked as a focused
  follow-up (will need a Notion-API-aware payload assembly that maps
  flag args to the structured POST body). Added a `whoami` read op so
  `ntn whoami` doesn't have to widen the `api` allowlist.

### T3 — `agentbox doctor` detection + docs  ✅ done
- `agentbox doctor` now reports each integration in a dedicated
  `integrations:` group, driven off `ALL_CONNECTORS` (no hardcoded
  `'notion'`) so Linear/Trello light up here automatically when they land.
  Each row probes `<hostBin> <versionArgs>` (install check) and
  `<hostBin> <authArgs>` (login check) and surfaces install/login hints
  from new optional `IntegrationConnector.detect.installHint` /
  `loginHint` fields (filled for the Notion connector). The doctor
  deliberately does NOT force `NOTION_KEYRING=0` — on the host the
  keychain entry IS the credential, and the file-auth env override would
  make a keychain-authed user falsely show as "not logged in". A new
  `info` `CheckStatus` rolls up like `ok` so a disabled-but-configured
  integration never pushes the overall doctor status to "warn". Unit
  test (`apps/cli/test/doctor-integrations.test.ts`) stubs a fake `ntn`
  on PATH and asserts the four transitions: disabled / missing /
  unauthed / authed.
- Docs:
  - `docs/integrations.md` — new internal design/reference doc
    (descriptor model, relay dispatch flow, the read/write Notion op
    surface, the enable flag, doctor wiring, the carry-based file-auth
    path for nested boxes, open follow-ups).
  - `apps/web/content/docs/integrations-notion.mdx` — new user-facing
    Fumadocs page (prerequisites, enabling, what works in the box,
    security model). Wired into `meta.json` under a new `---Services---`
    section.
  - `apps/web/content/docs/configuration.mdx` — new `## integrations`
    section documenting `integrations.notion.enabled`.
  - `apps/web/content/docs/cli.mdx` — `agentbox doctor` sentence
    updated to mention the new group.
  - `docs/host-relay.md` — new RPC method-family bullet for
    `integration.<service>.<op>` (parser, allowlist, enable gate,
    `refuseCall`, readiness probe, host-initiated token short-circuit,
    `askPrompt` for writes, the `<SERVICE>_*` env namespace guard).
  - `docs/features.md` — Notion integration bullet; the "Additional
    `/rpc` methods" line updated to list `gh.pr.*` /
    `integration.<svc>.<op>` already in place.

### T4 — Nested-box e2e verification + carry + closeout  ⬜ not started
- Carry `ntn` file-auth into a box; from that box create a nested box; run a
  `notion` read (no prompt) + a `notion` write (prompted, approve→succeeds,
  deny→nothing created), verifying ground truth in the live Notion space.
- Confirm a box never holds a Notion token (`printenv | grep -i notion`).
- Fix anything the e2e surfaces; mark the Notion path done in
  `integrations_backlog.md`.

## Status log
- 2026-06-06: Backlog created; host-side carry for `ntn` file-auth added to
  `agentbox.yaml`. Top-level box testing uses the host's keychain-authed `ntn`.
- 2026-06-06: T1 shipped — `@agentbox/integrations` package with Notion
  descriptor, `packages/relay/src/integrations.ts` (host exec + readiness
  probe), generic `integration.<svc>.<op>` dispatch wired into both
  `server.ts` (docker) and `host-actions.ts` (cloud), and `agentbox-ctl
  integration` command tree. PR pending.
- 2026-06-06: T2 shipped — `ntn-shim` + `notion` symlink on PATH across
  docker/hetzner/vercel/e2b; `integrations.notion.enabled` (default false)
  added to the typed config (with nested-key support in parser/merger/
  writer); host-side enable gate in `handleIntegrationRpc` returning exit
  65 with a config-hint when disabled; connector cleanup (dropped
  `comment.add`, added `whoami` read op). Comments deferred to a focused
  follow-up — they need a Notion-API-aware payload translator that maps
  CLI flags to the structured `POST /v1/comments` body.
- 2026-06-06: T3 shipped — `agentbox doctor` now reports the new
  `integrations:` group (registry-driven), with `info` for disabled and
  install/login hints sourced from the connector descriptor.
  `IntegrationConnector.detect` gained optional `installHint` /
  `loginHint` fields (filled for Notion: install URL + `ntn login`).
  Unit test stubs a fake `ntn` on PATH and verifies the four status
  transitions. Doctor's host probe does NOT set `NOTION_KEYRING=0` (a
  comment in the code records why). Public docs site + internal
  reference doc landed in the same PR: new `docs/integrations.md`, new
  `apps/web/content/docs/integrations-notion.mdx` (Services section in
  `meta.json`), config-key + doctor sentence in the published
  `configuration.mdx` / `cli.mdx`, new RPC method-family bullet in
  `docs/host-relay.md`, Notion entry in `docs/features.md`. T4 (nested-
  box e2e + carry-based file-auth verification) is the remaining task.
