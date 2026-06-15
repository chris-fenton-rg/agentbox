# Control box — build-out status

Status of the **control-box** feature: an always-on cloud box that runs the host
relay and holds a GitHub fine-grained PAT, so boxes keep pushing / opening PRs /
(later) being created when the user's laptop is off. Maintained live during
implementation (per project convention), not as end-of-PR cleanup.

Plan: `~/.claude/plans/to-allow-using-agentbox-rustling-comet.md`.

## The idea

Today the host relay (`agentbox-relay serve`) runs on the laptop and performs
every privileged action a box can't (git push, PR, box creation, cp, checkpoint)
with host-native credentials. Laptop off ⇒ all of that stops for cloud boxes.

A **control box** is just a `host`-mode relay running on an always-on cloud box,
reached by other cloud boxes the same way docker boxes already reach the laptop
relay — via the in-box `box-relay-forwarder`, but pointed at the control box's
**public HTTPS URL** instead of `host.docker.internal`. The control box has no
local checkout and no SSH/gh login, so it pushes with a **fine-grained PAT**
using the existing cloud git-bundle pull-back (materialize a throwaway repo from
the box's bundle → push to origin over HTTPS).

## Decisions (locked with the user)

- **Host:** provider-agnostic; persistent Vercel/E2B boxes are the natural fit
  (persistent snapshot + free public HTTPS preview URL). **Open risk:** does an
  inbound HTTPS request wake a *slept* persistent VM? → Phase 0 PoC.
- **GitHub auth:** fine-grained PAT, set/refreshed manually via
  `agentbox control-box set-token` (no refresh-token flow for fine-grained PATs).
  Stored on the control box (root-only env file), mirrored to
  `~/.agentbox/secrets.env`.
- **Phase 1 scope:** (1) git push + PRs, (2) creating new boxes — both laptop-off.
  Teleport-through-control-box and box→box fork are deferred.

## Comms model

```
cloud box  --(forwarder, https)-->  control-box relay (mode:'host', --control-box)
   |  /rpc git.push (per-box bearer)        |  executeCloudAction (PAT push)
   |  /events                               |  /admin/*, /remote/*  (admin bearer)
laptop CLI --(register-box, admin bearer)--> same relay
```

- `/admin/*` and `/remote/*` are gated on a constant-time **admin-bearer** match
  (not loopback) in control-box mode — the provider HTTPS proxy can present as
  loopback, so loopback is NOT trusted. Fails closed without a token.
- Per-box `/events` + `/rpc` keep their per-box bearers (already 0.0.0.0-safe).
- TLS terminates at the provider's public HTTPS proxy; the relay stays HTTP.

## Phase status

- [x] **W1 — control-box relay mode.** `RelayServerOptions.controlBox` +
  `adminToken`; `/admin/*` & `/remote/*` admin-bearer guard (constant-time,
  fail-closed); `agentbox-relay serve --control-box` reads
  `AGENTBOX_RELAY_ADMIN_TOKEN`. Laptop relay unchanged (loopback-only, `/remote`
  hidden). Unit tests: `packages/relay/test/control-box-admin.test.ts`.
- [~] **W2 — boxes/laptop reach the remote relay.**
  - [x] `box-relay-forwarder` picks `https.request` for an HTTPS upstream.
  - [x] `relay.controlBoxUrl` config key (all layers + registry).
  - [ ] `ENDPOINT` in `sandbox-docker/src/relay.ts` resolvable from
    `relay.controlBoxUrl`; `ensureRelay` bypasses the local spawn when set.
  - [ ] `registerBoxWithRelay`/`adminPost` parameterized base URL + admin bearer.
  - [ ] Thread the box origin URL into `BoxRegistration` (for `gh --repo`).
  - [ ] `daemon.ts` selects the forwarder (not in-box `mode:'box'`) when a
    control-box URL is present.
- [x] **W3 — PAT git push/PR.** `git-pat.ts` (`toAuthedHttpsUrl`,
  `repoSlugFromRemote`, `pushBundleToRemote`); `runGitRpc`/`runGhPrRpc`
  control-box variants; `assertGhReady` honors `GH_TOKEN`; server `/rpc` routes
  cloud-kind boxes through `executeCloudAction`. Unit tests:
  `packages/relay/test/git-pat.test.ts` (incl. a real local bundle→bare-repo push).
- [ ] **W4 — `agentbox control-box` command + provisioning + PAT lifecycle.**
  `create` / `set-token` / `status` / `stop` / `destroy`; provision a persistent
  cloud box, run the relay `--control-box`, expose 8787, generate + store the
  admin token; push the PAT to a root-only on-box env file.
- [ ] **W5 — create boxes from the control box.** Provider tokens on the box;
  `seedCloudWorkspace` origin-clone mode (clone via PAT, strip after); bearer-
  gated `POST /remote/queue/enqueue` reusing `startQueueLoop` + `runCloudJob`.

## Phase 0 PoC checklist (gates W4/W5 — run before building provisioning on top)

1. **Wake-on-inbound (make-or-break).** Provision a persistent Vercel (and/or
   E2B) box, run `agentbox-relay serve --port 8787 --control-box` with
   `AGENTBOX_RELAY_ADMIN_TOKEN` + `GH_TOKEN` set, expose 8787 publicly, let it
   auto-sleep (~45–60 min), then `curl https://<public-url>/healthz` and confirm
   it resumes + answers. Measure cold-resume latency. If it does NOT wake →
   fall back to an always-on VPS (Hetzner) with public ingress.
2. **PAT push from a no-checkout host** — already validated in unit form
   (`pushBundleToRemote` + `toAuthedHttpsUrl` against a local bare repo). Confirm
   live against a real PAT-scoped GitHub repo (`../agentbox-test-repo-gh`).
3. **Box reaches the public relay over the forwarder** — a second box forwards
   `/rpc git.push` to the control-box URL and the push lands on GitHub.

## Security notes

- Admin/remote endpoints: constant-time bearer, fail-closed, never loopback-open
  when `--control-box`.
- PAT blast radius is broader than per-box SSH (any repo in scope, any served
  box). Keep it fine-grained + short-lived; keep the `askPrompt` /
  host-initiated-token gates for non-`agentbox/` branches; unattended pushes to
  arbitrary branches need an explicit opt-in (`AGENTBOX_GIT_PUSH_NO_SUB=allow`
  or per-box `autoApproveHostActions`).
- PAT + provider tokens live in a root-only on-box env file, never baked into a
  snapshot. The push token lives in a throwaway temp remote URL, not in argv.
