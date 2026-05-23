# `drive` — PTY driver for interactive validation

A small validation tool for interactive AgentBox commands (`dashboard`, `claude`, `codex`, `opencode`, `shell`, `_cloud-attach`). Each `start` spawns the inner command in a real PTY, mirrors it into a headless xterm, and exposes a unix-domain socket so subsequent CLI calls can dump the rendered screen and send keystrokes.

Not a vitest harness — it is a manual-validation utility usable by humans and by Claude Code during the verify phase.

## Run

```
pnpm install        # once, picks up `tsx`
pnpm drive --help
```

All commands are invoked through the workspace script:

```
pnpm drive start [--cols C] [--rows R] [--name LABEL] [--cwd DIR] [--env K=V]... -- <cmd> [args...]
pnpm drive screen <id> [--ansi] [--with-cursor] [--rows R1:R2]
pnpm drive send <id> <keys...>
pnpm drive resize <id> <cols> <rows>
pnpm drive wait <id> --text "..." [--timeout 5000]
pnpm drive list [--json]
pnpm drive stop <id> | --all
```

`start` returns a session id (`<label>-<rand>` if `--name` is given, else a random hex). The id is the handle every other subcommand takes.

## Keystroke DSL

Plain text passes through. Angle-bracket tokens (case-insensitive) expand to bytes:

| Token | Bytes |
| --- | --- |
| `<Enter>` | `\r` |
| `<Tab>` | `\t` |
| `<Esc>` | `\x1b` |
| `<Space>` | ` ` |
| `<BS>` | `\x7f` |
| `<Del>` | `\x1b[3~` |
| `<C-a>`..`<C-z>` | `\x01`..`\x1a` |
| `<Up>`/`<Down>`/`<Left>`/`<Right>` | `\x1b[A`..`\x1b[D` |
| `<Home>`/`<End>`/`<PageUp>`/`<PageDown>` | standard xterm seqs |
| `<F1>`..`<F12>` | standard xterm seqs |
| `<<` | literal `<` |

Concatenation does NOT insert spaces between args: `drive send X "ls" "<Enter>"` writes `ls\r`.

## Typical scenarios

```bash
# 1. Smoke test the harness itself.
pnpm drive start --name smoke -- bash -lc "echo hello; sleep 30"
pnpm drive screen smoke
pnpm drive stop smoke

# 2. Dashboard end-to-end (needs at least one existing box).
pnpm -w build
pnpm drive start --name dash -- node apps/cli/dist/index.js dashboard
pnpm drive wait dash --text "Sessions" --timeout 5000
pnpm drive screen dash
pnpm drive send dash "<C-a>q"      # leader chord, then `q` to quit
pnpm drive list                    # session should be gone

# 3. Claude attach.
pnpm drive start --name claude -- node apps/cli/dist/index.js claude <BOX_ID>
pnpm drive wait claude --text "claude" --timeout 15000
pnpm drive screen claude
pnpm drive send claude "what is 2+2?<Enter>"
sleep 4 && pnpm drive screen claude
pnpm drive send claude "<C-a>d"    # tmux detach
```

## State location

Per-session sidecars live in `$TMPDIR/agentbox-drive/`:

- `<id>.sock` — unix-domain socket the daemon listens on
- `<id>.pid`  — daemon pid (so `stop` can SIGTERM a hung session)
- `<id>.meta` — JSON snapshot used by `list`
- `<id>.log`  — daemon stderr (look here if `start` reports the daemon didn't come up)

All four are removed automatically on clean shutdown; `stop` removes them as a fallback.

## Limits

- No live-stream of the PTY output. Use the real CLI for that — `drive` is for snapshot-style validation.
- `--ansi` is best-effort: walks xterm cells and emits SGR runs. Output is enough to inspect colors visually but is not byte-identical to the original stream.
- The session daemon dies when the inner PTY exits. `screen` returns the last rendered state for ~250 ms after exit before the socket disappears.
