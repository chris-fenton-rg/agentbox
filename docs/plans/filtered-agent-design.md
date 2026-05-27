# Filtered ssh-agent for `box.credentialForwarding=transient` — design doc

> **Status:** design only, not implemented. Saved here so we don't lose
> the research / plan; revisit when we want to tighten `transient` from
> "forward unrestricted agent" to "forward filtered agent".
>
> Original plan: `~/.claude/plans/smooth-rolling-matsumoto.md` (session-local).

## Context

The `transient` policy currently forwards the host's ssh-agent into the box with bare `ssh -A`. For the ~5s the SSH session is up, any process inside the box can use **any** of the user's loaded SSH keys to authenticate to **any** SSH server (the agent doesn't know "which host this is for" — it just signs the data the box sends).

We want to narrow that window: when the box asks the forwarded agent to sign, only allow the request through if the signature is bound to a known good host (github.com or gitlab.com by default), and only expose a filtered subset of identities.

Constraints:

- **macOS-only host** for v1. Don't carry weight for Linux hosts.
- **Narrow targets**. GitHub + GitLab as the bake-in allowlist; user-extensible later.
- **Prefer narrow + simple** over "support every git host."

## What exists in the ecosystem (researched)

- **[`tiwe-de/ssh-agent-filter`](https://github.com/tiwe-de/ssh-agent-filter)** — Debian C++ daemon that filters which KEYS are forwarded. Configured by key fingerprint. Doesn't validate destination. Linux-only, packaged via apt.
- **[`blueboxgroup/sshagentmux`](https://github.com/blueboxgroup/sshagentmux)** — Go proxy/multiplexer. No destination filtering.
- **OpenSSH's built-in [destination constraints](https://www.openssh.org/agent-restrict.html)** (`ssh-add -h destination`, OpenSSH 8.9+) — the cryptographically right answer, but the constraint must be set at `ssh-add` time by the user on the host. We can't apply it to keys we don't own. Useful as a one-line **recommendation** in our docs but not something we ship.
- **None of the above are good fits**: ssh-agent-filter is Linux-only and key-filter only; OpenSSH's built-in path requires user opt-in via `ssh-add`.

**npm building blocks (we'd build ourselves):**

- **[`ssh2`](https://www.npmjs.com/package/ssh2)** — `ssh2.AgentProtocol` (Duplex stream) parses/serializes the OpenSSH agent wire protocol; `ssh2.BaseAgent` is for implementing agents. Most mature, widely used. **This is what we'll use.**
- `sshpk` — key parsing/fingerprinting; we'll use it to compare server host keys against the allowlist.
- `ssh-agent-js` / `sshpk-agent` / `node-ssh-agent` — older/less maintained; no reason to prefer over ssh2.

**Verdict**: build our own narrow filter. ~250 LOC. ssh2 + sshpk handle the protocol mechanics; we add the policy.

## Design

### 1. Cryptographic basis — `publickey-hostbound-v00@openssh.com`

OpenSSH 8.9+ added an [extended pubkey auth method](https://github.com/openssh/openssh-portable/blob/master/PROTOCOL) where the client incorporates the **server's host public key** into the signed data. When the ssh client signs through a forwarded agent, the sign request's `data` payload is structured so the trailing field is the actual server hostkey blob. The agent can therefore extract "who is this signature for?" with cryptographic certainty (the hostkey is in the signed material, not just a hostname string).

OpenSSH versions in our environment:
- **Box** (Ubuntu 24.04 snapshot): OpenSSH 9.6 ✓
- **Host** (macOS): 14+ ships 9.x; macOS 13 has 8.x ✓ (≥8.9 required).

A boot-time check on the host's `ssh -V` is enough to refuse engagement on too-old systems and fall back to bundle.

### 2. The filter — `agentbox-filtered-agent`

New file: `packages/sandbox-cloud/src/filtered-agent.ts` (lives next to `host-credential-proxy.ts`).

Spawns per-RPC, listens on a temp Unix socket, forwards/filters to the real `$SSH_AUTH_SOCK`. Public API:

```ts
export interface FilteredAgent {
  /** Path to the temp Unix socket. Set as the box's $SSH_AUTH_SOCK via ssh -A. */
  socketPath: string;
  /** Per-request denials accumulated for the log line. */
  denials: { reason: string; key?: string; host?: string }[];
  /** Tear it down + remove the socket. */
  stop(): Promise<void>;
}

export interface StartFilteredAgentOpts {
  /** Real ssh-agent socket. Defaults to process.env.SSH_AUTH_SOCK. */
  upstreamSocketPath?: string;
  /** Allowed server host pubkeys (parsed sshpk format). Defaults to bundled GitHub + GitLab keys. */
  allowedHostKeys?: ReadonlyArray<sshpk.Key>;
  /** Optional key-comment glob to further restrict which identities are exposed. */
  allowedKeyCommentGlob?: string;
  log?: (line: string) => void;
}

export async function startFilteredAgent(opts?: StartFilteredAgentOpts): Promise<FilteredAgent>;
```

Behavior, message-by-message:

| Agent message from box | Filter action |
|---|---|
| `REQUEST_IDENTITIES` (11) | Forward to upstream. On the response, filter the returned `keys[]` by `allowedKeyCommentGlob` (default: no filter) so the box only sees what we want. |
| `SIGN_REQUEST` (13) | Parse the `data` field as a `publickey-hostbound-v00@openssh.com` blob. **If not hostbound → fail with `SSH_AGENT_FAILURE` (5).** If hostbound: extract the trailing server hostkey blob, compare (constant-time) against the allowlist. Match → forward to upstream. No match → `SSH_AGENT_FAILURE` + record denial. |
| `EXTENSION` (27) for `query` / version / etc | Forward (read-only). |
| Anything else (`ADD_IDENTITY` 17, `REMOVE_IDENTITY` 18, `REMOVE_ALL_IDENTITIES` 19, `ADD_SMARTCARD_KEY` 20, `REMOVE_SMARTCARD_KEY` 21, `LOCK` 22, `UNLOCK` 23, `ADD_ID_CONSTRAINED` 25, `ADD_SMARTCARD_KEY_CONSTRAINED` 26, `EXTENSION` writes) | Refuse with `SSH_AGENT_FAILURE`. The box has no business mutating our agent. |

Implementation: thin wrappers around `ssh2.AgentProtocol` on both the client side (listening socket) and upstream side (`net.connect(SSH_AUTH_SOCK)`).

### 3. Hostbound parsing

The signed blob in `publickey-hostbound-v00@openssh.com` is:

```
string  session_identifier   # opaque (SSH session ID)
byte    SSH_MSG_USERAUTH_REQUEST  (50)
string  username
string  service              # "ssh-connection"
string  "publickey-hostbound-v00@openssh.com"
bool    has_signature        # always TRUE for sign request
string  pubkey_algorithm
string  pubkey_blob
string  server_hostkey_blob  # ← the field we want
```

Helper: `parseHostboundSignBlob(data: Buffer): { serverHostKey: sshpk.Key } | null`. Returns `null` if the blob doesn't match the hostbound shape (older auth method, signing for git commits, etc.) — those get refused.

### 4. Bundled allowlist

`packages/sandbox-cloud/src/known-hosts.ts` (new). Frozen literal of the canonical GitHub + GitLab host keys (all algorithms — ed25519, ecdsa, rsa). Parsed once at module load via `sshpk.parseKey(...)`. These are public, [documented](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints).

User extension (v2): `box.credentialForwarding.allowedHosts` config (object form, optional) — accepts entries like `github.com`, `gitlab.com`, `gitea.example.com`. At startup we fetch each host's `ssh-keyscan` result, cache fingerprints, add to the allowlist. **v1: skip the dynamic fetch, support the two bundled hosts only.**

### 5. Wire into the `transient` policy

The user shipped `box.credentialForwarding: 'off' | 'transient'` in PR feat/credential-forwarding-policy. We're hardening `transient`, not adding a new value. Code path:

- **`packages/sandbox-hetzner/src/git-host-creds.ts`** (ssh-origin path) and **`packages/sandbox-cloud/src/workspace-seed.ts`** (seed fast path) both currently set `SSH_AUTH_SOCK` from the user's host env when invoking `ssh -A`. Change to:
  1. Probe `ssh -V` on host. If < 8.9 → return a "filter unsupported" sentinel; caller falls back to bundle path (log: `git fast path: host ssh too old for filtered agent forwarding; falling back to bundle`).
  2. Otherwise: `startFilteredAgent({ upstreamSocketPath: process.env.SSH_AUTH_SOCK, log })`.
  3. Run `ssh -A` with `SSH_AUTH_SOCK=<filteredAgent.socketPath>` in env (NOT `process.env.SSH_AUTH_SOCK`).
  4. On exit, `await filteredAgent.stop()` (always, in `finally`).
  5. If `filteredAgent.denials.length > 0`, log the count + first few examples so the user can see attempted misuse.

The HTTPS branch (`-R` credential proxy) doesn't go through the filtered agent — it forwards a credential helper, not the agent. Unchanged.

### 6. macOS-only scoping

The plan's stated constraint. Two places this matters:

- **Host ssh version probe**: macOS 14+ ships OpenSSH ≥9.x. macOS 13 has 8.x but might have 8.6 (too old). The probe is universal — handles linux too — so the "macOS only" framing is just about who we expect to use it; the code degrades gracefully elsewhere.
- **`SSH_AUTH_SOCK` discovery**: macOS uses launchd for ssh-agent (`/private/tmp/com.apple.launchd.<rand>/Listeners`). Already in `process.env.SSH_AUTH_SOCK` when the user has loaded keys. No special handling needed beyond what we have.

### 7. Failure modes + fallback

| Scenario | Behavior |
|---|---|
| Host ssh < 8.9 | Filter would never see hostbound requests → log + fall back to bundle path. |
| Box ssh < 8.9 (shouldn't happen, but) | All sign requests come in as non-hostbound → filter refuses → ssh push fails → fall back to bundle (already wired through the existing auth-failure detection in `host-actions.ts`). |
| Box requests a sign for a host not in allowlist | `SSH_AGENT_FAILURE`. Push fails with `Permission denied (publickey)`. `host-actions.ts` `isFastPathAuthFailure(res, 'ssh')` catches this → falls back to bundle. Log records the attempted host. |
| Upstream `SSH_AUTH_SOCK` missing / unreachable | Filter exits with clear error; caller logs + falls back to bundle. |

### 8. Threat model — what this DOES NOT protect against

Be honest about this in `docs/cloud-providers.md`:

- A hostile box could read the SSH session's data and try to ride the existing `ssh -A` channel to do other things — but the agent is the bottleneck for all signing, so a key the agent refuses to use can't be used.
- If the user has loaded a key that GitHub legitimately accepts AND that the same upstream host (under attacker control) could intercept — out of scope; nothing we do prevents that.
- The filter doesn't prevent the box from `git push`ing arbitrary commits to GitHub on the user's behalf. That's the whole point of the feature; protect with the `askPrompt()` confirmation gate (already in place for non-`agentbox/*` branches).

### 9. Tests

- **Unit (vitest)**, `packages/sandbox-cloud/test/filtered-agent.test.ts`:
  - Parses a recorded `publickey-hostbound-v00@openssh.com` sign request, extracts the right hostkey.
  - Rejects a non-hostbound sign request.
  - Forwards / filters identity list according to comment glob.
  - Refuses ADD_IDENTITY / REMOVE_IDENTITY / LOCK.
  - Allowlist match (GitHub ed25519) → forwards. No match (some random host's key) → fails.
- **Integration**: start filter against a mock upstream agent (also a Node TCP server speaking the protocol), connect a real `ssh-add -l` to it, verify identity list is filtered. Then `ssh -i somekey user@unrelated.host` against a local sshd, verify the sign request is refused.
- **E2E on Hetzner**: with `box.credentialForwarding=transient`, push to github.com via fast path → success. Attempt (from inside the box) `ssh git@unrelated.example.com` → refused; log records denial.

## Critical files (when implementing)

- `packages/sandbox-cloud/src/filtered-agent.ts` (new, ~250 LOC) — the filter implementation.
- `packages/sandbox-cloud/src/known-hosts.ts` (new, ~40 LOC) — bundled GitHub + GitLab host keys.
- `packages/sandbox-cloud/test/filtered-agent.test.ts` (new) — unit tests.
- `packages/sandbox-cloud/package.json` — add `ssh2` and `sshpk` to dependencies.
- `packages/sandbox-hetzner/src/git-host-creds.ts` — wrap `sshExecWithAgent` invocation with `startFilteredAgent` + ssh-version probe.
- `packages/sandbox-cloud/src/workspace-seed.ts` (`tryFastClone`) — same wrap.
- `docs/cloud-providers.md` §3.10 — document filtering, the bundled allowlist, the `ssh-add -h` recommendation as a complementary defense.
- `docs/hertzner_backlog.md` — note that `transient` now means "filtered".

## Out of scope (v1)

- Dynamic user-extensible allowlist via `box.credentialForwarding.allowedHosts` config. Configurable in v2 if asked; for v1 GitHub + GitLab are baked in.
- `ssh-add -h destination` constraint check + warning when keys lack constraints. Worth adding alongside as documentation but not code.
- Audit log persistence — for v1 denials log to the relay log only; no separate audit file.
- Linux host support — code degrades gracefully but isn't actively tested.
- HTTPS-origin credential proxy filtering — separate concern; the credential proxy already only serves one host (the upstream from `git remote get-url`).

## References

- [tiwe-de/ssh-agent-filter](https://github.com/tiwe-de/ssh-agent-filter) — Linux daemon, key-only filter.
- [blueboxgroup/sshagentmux](https://github.com/blueboxgroup/sshagentmux) — Go multiplexer.
- [SSH agent restriction](https://www.openssh.org/agent-restrict.html) — OpenSSH built-in destination constraints.
- [OpenSSH PROTOCOL.agent](https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.agent) — agent wire protocol.
- [OpenSSH PROTOCOL](https://github.com/openssh/openssh-portable/blob/master/PROTOCOL) — `publickey-hostbound-v00@openssh.com` definition.
- [ssh2 npm](https://www.npmjs.com/package/ssh2) — AgentProtocol + BaseAgent.
- [sshpk npm](https://www.npmjs.com/package/sshpk) — key parsing.
- [Restricting SSH agent keys — LWN.net](https://lwn.net/Articles/880458/) — overview article.
- [GitHub's SSH key fingerprints](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints) — bundled allowlist source.
