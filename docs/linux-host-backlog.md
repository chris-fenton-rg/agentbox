# Linux host support — backlog

AgentBox's CLI grew up assuming a **macOS host**. We now want it to also run on a
**Linux host (primarily Ubuntu)** — i.e. a developer driving `agentbox` from a Linux
laptop/server, spinning up docker/cloud boxes from there. This file tracks what
already works, what's been fixed, and the remaining macOS-only host assumptions.

> Scope note: this is about the **host** running the CLI. The *boxes* (docker
> images, cloud VMs) have always been Linux — that part is unaffected.

## Done

- **`agentbox doctor` is Linux-aware** (`apps/cli/src/lib/doctor-checks.ts`):
  - `checkPlatform()` returns `ok` for `darwin`/`linux`, `warn` for any other OS
    (Windows etc.) with an "untested OS" hint — instead of blindly reporting `ok`.
  - The docker-cli "not found" hint is platform-specific (Linux points at
    `https://docs.docker.com/engine/install/`).
  - The docker **daemon** check now distinguishes the #1 Linux failure — `docker
    info` exiting with *permission denied* because the user isn't in the `docker`
    group — from a genuinely stopped daemon, and emits the right fix
    (`sudo usermod -aG docker $USER` vs `sudo systemctl start docker`).
  - Verified live on a clean Ubuntu 24.04 Hetzner VM (see below): both the
    permission-denied branch and the healthy `reachable` path render correctly,
    and the daytona/hetzner/vercel credential checks run without crashing.

- **Host browser/file opening uses `xdg-open` on Linux.** Added
  `hostOpenCommand()` to `@agentbox/sandbox-core` (`darwin` -> `open`, `linux` ->
  `xdg-open`) with a unit test, and routed every host-side launcher through it
  instead of the hardcoded macOS `open`:
  - apps/cli: `url`, `screen`, `code` (CLI-missing fallback), `open` (sshfs mount
    reveal), `dashboard` (VNC/web/code openers)
  - relay: the box-initiated "open link on host" path (`host-actions.ts`,
    `server.ts`)
  - cloud login dashboards: daytona / vercel / hetzner `credentials.ts`
  - `sandbox-docker` checkpoint/export reveal (`host-export.ts`)
  - Verified live on the Ubuntu VM: `agentbox url <box>` launches via `xdg-open`
    (not `open`) — see the dev-VM E2E below.

- **Terminal attach on Linux: tmux only (by decision).** `detectHostTerminal()`
  recognizes tmux via `$TMUX` on every host, so attach-in-new-window/pane works on
  Linux when you're inside tmux. The iTerm2 path (`spawnInITerm2()` →
  `osascript`, `apps/cli/src/terminal/host.ts`) stays macOS-only. We deliberately
  do **not** recognize native Linux emulators (gnome-terminal / alacritty /
  konsole) for now: outside tmux the caller falls back to attaching in the current
  terminal (and `agentbox fork` passes `--no-attach`). Revisit only if there's
  demand for native-emulator spawning.

## How to test on Linux

`scripts/linux-dev-vm.sh` manages a **persistent** clean Ubuntu VM on Hetzner
(`cx23` / `nbg1` / `ubuntu-24.04` — the repo's hetzner defaults; cloud-init
installs Node 20 + docker + git + tmux and a non-root `dev` user in the docker
group with passwordless sudo). It is a bare VPS you log into and drive the CLI on
— **not** an agentbox box. State (server id / ip / key) lives in
`~/.agentbox/linux-dev-vm/`, so the VM survives across edit→deploy→test cycles
until you explicitly `down` it.

```bash
scripts/linux-dev-vm.sh up                 # create (idempotent — reuses a live VM)
scripts/linux-dev-vm.sh deploy             # build + npm pack + install -g the latest CLI
scripts/linux-dev-vm.sh deploy --no-build  # reuse an existing dist/
scripts/linux-dev-vm.sh ssh                # interactive shell as `dev`
scripts/linux-dev-vm.sh ssh -- agentbox ls # run a one-off command
scripts/linux-dev-vm.sh doctor             # two-phase doctor (perm-denied + healthy)
scripts/linux-dev-vm.sh info               # server id / ip / ssh command
scripts/linux-dev-vm.sh down               # destroy server + key + local state
```

`HCLOUD_TOKEN` is read from the env, then `.env.local`, then
`~/.agentbox/secrets.env`.

Notes learned the hard way:
- Run the CLI via a **login shell** (`su - <user> -c …` / `ssh dev@…`), not
  `sudo -u <user> <bin>` — the latter hands the node process a reduced PATH where
  `/usr/bin` tools (git/ssh/docker) and the npm global bin aren't all resolvable,
  so `doctor` falsely reports them "not found".
- The `doctor` subcommand creates a throwaway `probe` user (no docker group) to
  exercise the *permission denied* daemon branch, then runs as `dev` (in the
  group) for the healthy path.

Manual recipe (any Ubuntu host, no script):
```bash
# on the host
pnpm -w build && (cd apps/cli && npm pack)        # -> madarco-agentbox-*.tgz
scp madarco-agentbox-*.tgz user@host:~
# on the Ubuntu box
sudo npm install -g ./madarco-agentbox-*.tgz
agentbox doctor                                   # inspect the report
```

## Open blockers (not yet done — host code still macOS-only)

These were found while scoping the doctor change. None are needed for `doctor`
itself; they block the wider "drive everything from Linux" goal.

- **OrbStack-only fast paths assume macOS** and should be skipped on Linux (OrbStack
  is macOS-only; on Linux the docker socket / volume paths differ):
  - `packages/sandbox-docker/src/host-export.ts` (`orbstackVolumePath`, ~L138)
  - `packages/sandbox-docker/src/stats.ts:77`
- **Docs / CLAUDE.md still describe the CLI as macOS-oriented** in places — update
  the relevant statements once broader support lands.

## Already cross-platform (verified — no work needed)

- **Clipboard capture** (`apps/cli/src/lib/host-clipboard.ts`) already has a Linux
  path (`wl-paste` for Wayland, `xclip` for X11); the macOS `sips`/`osascript` path
  is gated behind `process.platform === 'darwin'`.
- **Vercel CLI store** (`packages/sandbox-vercel/src/cli-store.ts`) resolves
  `$XDG_DATA_HOME` / `~/.local/share` on Linux.
- **Snapshot copy** (`packages/sandbox-docker/src/snapshot.ts:105`) already branches
  `-cR` (macOS APFS CoW) vs `-R` (Linux).
- **State/config paths** (`~/.agentbox`, `~/.ssh/config`) are all `homedir()`-based.
