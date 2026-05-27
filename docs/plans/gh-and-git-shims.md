# Plan — `gh` + `git` shims inside the box

## Context

Two related gaps inside an agentbox box:

1. **Claude Code's PR badge stays dark.** Claude Code lights up the "branch → PR #N" badge (and `pr.number` / `pr.url` / `pr.review_state` in statusline JSON) by shelling out to `gh pr view --json …`. There's no REST-API fallback, no `.git/config` lookup, no env override — `gh` *must* be on `PATH` and `gh auth status` must succeed. The box has no `gh` (Dockerfile only mentions it in a `BROWSER` comment), and giving the in-box agent a GitHub token is explicitly off-limits (per the "gate at host boundary, not at the agent" principle).

2. **Agents call raw `git push`/`git pull`/`git clone` and fail.** The supported path today is `agentbox-ctl git push|fetch|pull` (routed through the relay, using host creds). But Claude Code and any tool that just shells out to `git` don't know to call `agentbox-ctl`. The recent ssh-A + cred-proxy commit (9d88309) only addresses the hetzner provider; docker/daytona still need host-mediated git for push/pull, and nothing handles `git clone <url>` of a *different* repo on any provider.

The relay already exposes `gh.pr.<op>` RPCs (8 ops; read-only ones skip the host prompt — `packages/relay/src/gh.ts`) and `git.push` / `git.fetch` RPCs (the latter with the recent auto-allow for `agentbox/<name>` branches — commit 67fa492). What's missing is (a) `gh`-named and `git`-named entry points on the box's `PATH`, and (b) one new `git.clone` RPC for clone-of-a-different-repo. Plus one tiny `gh.repo.clone` op for `gh repo clone <owner/name>`.

Decisions:
- **gh shim surface**: all 8 `gh pr` ops + `gh auth status` + `gh --version` + `gh repo clone`.
- **git shim**: intercept network ops only — `git push|pull|fetch|clone`. Everything else (`commit`, `status`, `log`, `diff`, `add`, `checkout`, branch ops, …) falls through to real `/usr/bin/git`. Strict per-op flag whitelist; reject unknown flags with a clear error.
- **Install**: baked into the box image via `Dockerfile.box`. One image covers docker / daytona / hetzner.

## Approach

Three concentric layers:

### Layer 1 — `agentbox-ctl gh` top-level command (new)

`packages/ctl/src/commands/gh.ts`:
- `agentbox-ctl gh pr <op> [args...]` — wire payload `{ method: 'gh.pr.<op>', params: { path, args } }`. Reuse `PR_SUBCOMMANDS` from `commands/git.ts:55` (factor it into a shared `pr-subcommands.ts` so `git pr` and `gh pr` stay in lockstep).
- `agentbox-ctl gh repo clone <repo> [dir]` — strict whitelist: positional repo (`owner/name` or full URL), optional positional dir. Flags allowed: `--branch <name>`, `--depth <n>`. Wire to new RPC `gh.repo.clone` (see Layer 3).
- `agentbox-ctl git clone <url> [dir]` — strict whitelist as above. Wire to new RPC `git.clone`.

`packages/ctl/src/bin.ts` — add `program.addCommand(ghCommand)` alongside `gitCommand` (`bin.ts:44`). Add a `clone` subcommand to the existing `gitCommand` in `commands/git.ts`.

### Layer 2 — the two PATH shims (new bash scripts)

Both live under `packages/sandbox-docker/scripts/` and get `COPY`'d in `Dockerfile.box` next to `agentbox-open` (`Dockerfile.box:367`). Plain bash (no node startup per call — Claude Code may invoke these many times per second).

**`/usr/local/bin/gh`** (~50 lines):
- `gh --version` → static `gh version 2.0.0 (agentbox-shim)` to stdout, exit 0.
- `gh auth status [...]` → emit `Logged in to github.com (via agentbox host relay)` to stderr, exit 0. Real auth state is verified host-side on the next real RPC (relay's `assertGhReady` returns exit 4 with the real error if the host is logged out).
- `gh pr <op> [args...]` (op ∈ {view, list, create, comment, review, merge, checkout, close, reopen}) → if op is `view` or `list` and no positional ref/branch is present, inject `$(git -C "$PWD" rev-parse --abbrev-ref HEAD)` before the flags so the host's `gh` resolves against the right branch. Then `exec agentbox-ctl gh pr <op> -- "$@"`.
- `gh repo clone <repo> [dir]` → reject any flag not in `{--branch, --depth}`. `exec agentbox-ctl gh repo clone -- "$@"`.
- Anything else → stderr "agentbox gh shim: `gh <subcmd>` not proxied (supported: `gh pr {…}`, `gh repo clone`, `gh auth status`, `gh --version`)"; exit 2.

**`/usr/local/bin/git`** (~70 lines):
- Real git path is `/usr/bin/git` (resolved once at top with `command -v`; cached). The shim must NOT loop on itself.
- Dispatch on `$1`:
  - `push` → strict whitelist of flags: `--force-with-lease`, `--tags`, `--set-upstream`, `--dry-run`, `-u` (alias for `--set-upstream`). Positional remote/branch rejected (the ctl already builds them from the registered worktree — re-passing them yields the `refs/remotes/origin/HEAD cannot be resolved` failure documented in `commands/git.ts:131`). `exec agentbox-ctl git push -- "$@"`.
  - `pull` → flags allowed: `--ff-only`, `--rebase`, `--no-rebase`, `--prune`. `exec agentbox-ctl git pull -- "$@"`.
  - `fetch` → flags allowed: `--prune`, `--tags`, `--all`. `exec agentbox-ctl git fetch -- "$@"`.
  - `clone` → flags allowed: `--branch <name>`, `--depth <n>`, `--single-branch`. Reject `--recurse-submodules`, `--reference`, `--template`, `--separate-git-dir`, etc. Positional 1 must be a URL or `owner/name`. `exec agentbox-ctl git clone -- "$@"`.
  - Any other first arg (`commit`, `status`, `log`, `diff`, `add`, `checkout`, `branch`, `stash`, `merge`, `rebase`, `show`, `rev-parse`, …) → `exec /usr/bin/git "$@"`. No interception, no overhead.
- Rejection message format: `agentbox git shim: unsupported flag --foo for 'git push'. Allowed: --force-with-lease, --tags, --set-upstream, --dry-run` then exit 2.
- PATH ordering: image's `ENV PATH=/home/vscode/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` already puts `/usr/local/bin` ahead of `/usr/bin`. Shim wins.

### Layer 3 — new relay RPCs (minimal)

`packages/relay/src/gh.ts` and `packages/relay/src/host-actions.ts`:
- **`gh.repo.clone`** — params `{ url, targetPath, args? }`. Whitelist on the relay too (defense in depth): `--branch`, `--depth` only. Host runs `gh repo clone <repo> <hostTmp> <args>` in a fresh tmpdir, then ships the result into the box via the same transfer used by `git.clone` (below).
- **`git.clone`** — params `{ url, targetPath, args? }`. Whitelist enforced. Two-stage on the host:
  1. `git clone --bare <url> <hostTmp>.git <args>` with host creds.
  2. `git bundle create <hostTmp>.bundle --all` → return the bundle to the box via the existing relay file-stream path (the `cp` / `download` endpoint already moves bytes box↔host). Box-side ctl receives the bundle, runs `git clone <bundle> <targetPath>` inside the box, then `git remote set-url origin <originalUrl>`. The bundle path is the cleanest cross-provider transfer (no scp/bind-mount asymmetry — works identically on docker, daytona, hetzner).
- Both RPCs read-only from a permission standpoint (cloning a public repo doesn't mutate host state). For `gh repo clone` of a *private* repo where the user might want a prompt, fall back to the existing `askPrompt()` host confirmation pattern used by the other `gh` write ops.
- Target path validation: must resolve inside the box's `/workspace` (or wherever the ctl invocation's `--cwd` says); reject `..` escapes and absolute paths outside the registered worktree.

## Critical files to modify

### New files
- `packages/ctl/src/commands/gh.ts` — top-level `gh` command (pr + repo clone).
- `packages/ctl/src/commands/pr-subcommands.ts` — factored-out `PR_SUBCOMMANDS` shared by `gh.ts` and `git.ts`.
- `packages/sandbox-docker/scripts/gh-shim` — bash shim for `gh`.
- `packages/sandbox-docker/scripts/git-shim` — bash shim for `git`.

### Modified files
- `packages/ctl/src/commands/git.ts` — import `PR_SUBCOMMANDS` from new file; add `clone` subcommand to `gitCommand`.
- `packages/ctl/src/bin.ts` — register `ghCommand`.
- `packages/relay/src/gh.ts` — add `repo.clone` to the whitelist + handler + strict-args validator.
- `packages/relay/src/host-actions.ts` — `runGhPrRpc` parallel: `runGhRepoCloneRpc`, `runGitCloneRpc`. Reuse the existing file-transfer plumbing for the bundle hop.
- `packages/relay/src/server.ts` — wire the new RPC methods in the docker dispatch path.
- `apps/cli/runtime/docker/Dockerfile.box` — `COPY` both shims into `/usr/local/bin/{gh,git}` + `chmod +x`, placed after the `agentbox-ctl` COPY at `:141` and before the trailing `USER vscode` block.

### No changes needed
- Hetzner / Daytona provider code — both inherit the same image. Rebake on next `agentbox prepare --provider hetzner` (hetzner) / next Daytona snapshot refresh.
- Existing `git.push` / `git.fetch` RPCs — they already do the right thing, including the auto-allow for `agentbox/<name>` branches.

## Verification

1. **Unit tests** (`packages/ctl/test/`, `packages/relay/test/`):
   - ctl: `agentbox-ctl gh pr view --json number,url` produces wire payload `{ method: 'gh.pr.view', params: { path, args: ['--json', 'number,url'] } }`.
   - ctl: `agentbox-ctl git clone https://github.com/x/y.git ./y --branch main` → wire payload includes only the whitelisted flags.
   - relay: `gh.repo.clone` rejects `--reference` / `--template` with exit 22 and a clear stderr.
   - shim arg-whitelist: a vitest spec that spawns the bash shim with disallowed flags and asserts exit code + stderr message. Use a stubbed `agentbox-ctl` on `PATH` so the exec doesn't actually fire.

2. **Image rebuild** (per CLAUDE.md, not `agentbox prepare` since the box runs without `CAP_SYS_PTRACE`):
   ```
   docker build --network=host -t agentbox/box:dev -f apps/cli/runtime/docker/Dockerfile.box apps/cli/runtime/docker
   ```

3. **End-to-end smoke** (docker provider first):
   - `node apps/cli/dist/index.js create -y -n shim-smoke &` then `tail -f ~/.agentbox/logs/create.log`.
   - Host has authenticated `gh`. Inside the box:
     - `gh --version` → static line, exit 0.
     - `gh auth status` → success line, exit 0.
     - Push an empty commit + create a PR via the new shim:
       `git commit --allow-empty -m wip && git push && gh pr create --fill --draft`.
     - `gh pr view --json number,url,state,reviewDecision` → JSON with the new PR.
     - `git pull --ff-only` → succeeds via relay.
     - `git clone https://github.com/madarco/agentbox-test-repo.git ./clone-test --depth 1` → ends up in `/workspace/clone-test`, `git -C clone-test log` shows the repo.
   - Launch `agentbox claude -n shim-smoke`, drive via `pnpm drive` if needed, confirm PR badge appears in the statusline.

4. **Negative paths** (inside the box):
   - `gh issue list` → exit 2 with shim "not supported" message.
   - `git push --no-verify origin some-other-branch` → rejected by shim arg-whitelist (positional refspec + unlisted flag).
   - `git clone --recurse-submodules <url>` → rejected.
   - `git status` / `git log` → fall through unchanged (no extra latency, no shim text).

5. **Provider cross-check** (after docker green):
   - `agentbox prepare --provider hetzner` to rebake the base snapshot, spin a hetzner box, repeat the gh + git smoke. Confirms the bundle-transfer path works cross-provider via the relay's existing file-stream.
   - Daytona uses the same image; usually no separate snapshot rebake needed unless `docs/cloud-create-flow.md` indicates otherwise.
