# Docs images — capture guide

How to (re)produce every screenshot the docs need, from **one** test environment.
Read top to bottom: provision the environment once (Section 1), keep the tooling
handy (Section 2), then sweep the catalog in phase order (Section 3) so you barely
switch context.

Images live in `apps/web/public/screenshots/` and are referenced from
`<Figure src="/screenshots/<name>.png" />` in `content/docs/*.mdx`. Line numbers
below are approximate — **match figures by caption**, not line.

## Status

| Image | Used by (doc figures) | Status | Phase |
|-------|------------------------|--------|-------|
| `web-app.png` | web-apps-and-tunnels | TODO | A |
| `novnc-desktop.png` | access-your-box, browser-and-screen | done (improve: show the app in the in-box browser) | A |
| `agentbox-ls.png` | background-and-parallel | done | B |
| `dashboard.png` | access-your-box, background-and-parallel, cli | done | C |
| `claude-tui.png` | run-an-agent, cli | TODO | C |
| `cursor.png` | access-your-box (Cursor / Dev Containers) | TODO | C |
| `push-approval.png` | sync-and-git (push approval) | TODO (best-effort) | C |
| diagram — core-concepts | core-concepts (box/relay model) | TODO (draw) | D |
| diagram — configuration | configuration (resolution order) | TODO (draw) | D |
| diagram — services DAG | services-and-tasks (`needs` DAG) | TODO (draw) | D |
| diagram — sync/git | sync-and-git (commits land / relay) | TODO (draw) | D |
| diagram — teleport | teleport-a-project (repo → branch) | TODO (draw) | D |
| `hetzner-token.png` | hetzner (API token console) | TODO (external) | E |

---

## 1. Test environment (provision once)

The base project is `examples/express-ready` — its `agentbox.yaml` declares an
`install` task and a `web` service on **port 3000** (exposed at
`https://<box>.localhost`) with a `ready_when` probe, so each box auto-runs a real
web app. That covers the web-app, noVNC, services, dashboard, and ls shots.

```bash
# 1) Destroy every existing box (clean slate)
for ref in $(agentbox ls --global --json | jq -r '[.. | .id? // empty] | unique[]'); do
  agentbox destroy "$ref" -y
done
agentbox ls --global         # confirm empty (also check: docker ps | grep agentbox-)

cd examples/express-ready
```

**Hero box** (`web`, docker) — launch it **attached in its own iTerm window**. An
attached, live Claude session is what the dashboard mirrors and what noVNC
reflects (a background `-i` run is not live-mirrorable):

```bash
osascript \
  -e 'tell application "iTerm" to activate' \
  -e 'tell application "iTerm" to set b to (create window with default profile)' \
  -e "tell application \"iTerm\" to tell current session of b to write text \"cd $PWD && agentbox claude --provider docker -n web\""
```

Give the hero box a real task (`express-ready` is a tiny Express HTTP server, so
"improve the home page" produces a visible result for the web-app and noVNC shots).
Send the prompt into the box's `claude` tmux session (same trick used to `/clear`):

```bash
SESS=$(docker exec agentbox-web bash -lc "tmux ls 2>/dev/null | grep -i '^claude:' | head -1 | cut -d: -f1")
docker exec agentbox-web bash -lc "tmux send-keys -t '${SESS:-claude}' 'Improve the home page of this Express app — turn it into a clean landing page, then restart the web service so the change is live.' Enter"
```

**Two more boxes across providers**, with background tasks (they show
`claude:working` in `ls`/dashboard; provider variety for the `ls` shot). One is a
**plan** so the dashboard/ls can show an agent in plan mode:

```bash
agentbox claude --provider hetzner -n api   -i "Plan a todo app: write a detailed implementation plan. Don't write any code yet."
agentbox claude --provider vercel  -n cloud -i "Add a /health endpoint to server.js that returns 200 OK."

agentbox ls                  # web (docker, improving the home page) + api (hetzner, planning) + cloud (vercel)
```

> Let the **`web`** agent finish "improve the home page" (and the service restart)
> before the Phase A captures below — the web-app and noVNC shots should show the
> *new* home.

**Cleanup (after all captures):**

```bash
agentbox destroy web api cloud -y
```

Close only the iTerm windows **you** opened (by id — see the caveat below). Never
touch your own session window.

---

## 2. Tooling

### 2a. Terminal render (clean, on-brand card)

For command output (e.g. `agentbox ls`) rendered in the docs' dark-terminal style.
Write this helper to `/tmp/gen-term.js`:

```js
// Render captured terminal output into an on-brand "terminal" HTML card.
// usage: node gen-term.js <output.txt> "<command label>" <out.html> [title]
const fs = require('fs');
const [, , outFile, cmd, htmlFile, titleArg] = process.argv;
const title = titleArg || 'agentbox — zsh';
const raw = fs.readFileSync(outFile, 'utf8')
  .split('\n').map((l) => l.replace(/\s+$/, '')).join('\n') // trim per-line padding (TUI captures)
  .replace(/\n{3,}/g, '\n\n') // collapse big blank runs
  .replace(/^\n+|\n+$/g, '');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const body = `<span class="pr">$ </span><span class="cmd">${esc(cmd)}</span>\n` + esc(raw);
const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0}
  body{background:#f6f6f3;padding:46px;font-family:"IBM Plex Mono",ui-monospace,monospace}
  .term{max-width:980px;margin:0 auto;background:#15171b;border:1px solid #262a31;border-radius:10px;overflow:hidden;
    box-shadow:0 20px 44px -28px rgba(20,24,30,.5),0 2px 8px -3px rgba(20,24,30,.22)}
  .bar{display:flex;align-items:center;gap:6px;padding:11px 14px;background:#1b1e24;border-bottom:1px solid #262a31}
  .d{width:11px;height:11px;border-radius:50%}
  .r{background:#ec6a5e}.y{background:#f4bf4f}.g{background:#61c554}
  .title{margin-left:9px;font-size:12px;color:#6c727b;letter-spacing:.02em}
  pre{padding:18px 18px 20px;font-size:14.5px;line-height:1.75;color:#c8ccd3;white-space:pre;overflow:auto}
  .pr{color:#4ec98a}.cmd{color:#f0f2f5}
</style></head><body>
<div class="term"><div class="bar"><span class="d r"></span><span class="d y"></span><span class="d g"></span><span class="title">${esc(title)}</span></div>
<pre>${body}</pre></div></body></html>`;
fs.writeFileSync(htmlFile, html);
console.log('wrote', htmlFile);
```

Then capture (playwright-cli blocks `file://`, so serve over http):

```bash
agentbox ls > /tmp/out.txt
node /tmp/gen-term.js /tmp/out.txt "agentbox ls" /tmp/term.html "agentbox — zsh"
( cd /tmp && python3 -m http.server 8899 >/dev/null 2>&1 & )
playwright-cli session-stop-all
playwright-cli --session=t open "http://localhost:8899/term.html"
playwright-cli --session=t resize 1100 430        # size to fit the card
playwright-cli --session=t screenshot             # prints the saved PNG path
lsof -ti tcp:8899 | xargs kill -9
```

Copy the printed PNG into `apps/web/public/screenshots/<name>.png`.

### 2b. Real window capture (color, authenticity)

Use the screenshot skill for colored TUIs (dashboard, Claude) and GUI apps (Cursor):

```bash
SK=.claude/skills/screenshot/scripts
bash "$SK/ensure_macos_permissions.sh"                      # once
python3 "$SK/take_screenshot.py" --list-windows --app "iTerm"   # find the window id
python3 "$SK/take_screenshot.py" --mode temp --window-id <ID>   # capture that window only
```

> **Caveat — capture by `--window-id`, never `--active-window` / "front window".**
> Focus-based capture can grab (and resizing osascript can *resize*) your own
> Claude session window. Always `--list-windows` first and target the id of the
> `AgentBox: …` window.

### 2c. Crop (drop the iTerm status bar / window chrome)

```bash
python3 - <<'PY'
from PIL import Image
im = Image.open("/tmp/<shot>.png")
w, h = im.size
im.crop((0, 0, w, int(h * 0.92))).save("apps/web/public/screenshots/<name>.png")  # tune 0.92
PY
```

For the dashboard/Claude windows: `/clear` the Claude pane first (removes the
"Remote Control failed…" startup line) — send it via tmux like the task prompt
above, or type it.

---

## 3. Image catalog — capture in this order

### Phase A — Headless browser (boxes running)

**`web-app.png`** → web-apps-and-tunnels. The improved Express home page at
`<box>.localhost` (capture after the `web` agent finishes).

```bash
agentbox url web --print          # -> https://web.localhost
playwright-cli --session=b open "https://web.localhost"
playwright-cli --session=b resize 1100 720
playwright-cli --session=b screenshot
```

**`novnc-desktop.png`** → access-your-box, browser-and-screen. The box desktop with
the in-box Chromium showing the box's web app.

**Capture this LAST**, on the **`web`** box, once "improve the home page" has
finished — so the desktop shows the new landing page. `agentbox screen` both prints
the noVNC URL **and** launches an in-box Chromium pointed at the box's web app
(`localhost:3000`), so the desktop already has the app on screen.

```bash
agentbox screen web --print       # starts the in-box Chromium on the app; prints https://web.localhost/vnc.html?autoconnect=1&password=...
playwright-cli --session=v open "<that URL>"
# wait ~5s for the noVNC canvas to connect and Chromium to paint the home page, then:
playwright-cli --session=v resize 1044 800
playwright-cli --session=v screenshot
```

### Phase B — Rendered terminal

**`agentbox-ls.png`** → background-and-parallel. `agentbox ls` with web/api/cloud
across docker/hetzner/vercel, agents working. Use the render flow in §2a; viewport
~`1100 430`.

### Phase C — Real terminal / app windows (skill + crop)

**`dashboard.png`** → access-your-box, background-and-parallel, cli. Open the
dashboard pre-selected on the hero box (its live Claude shows in the right pane):

```bash
osascript -e 'tell application "iTerm" to activate' \
  -e 'tell application "iTerm" to set b to (create window with default profile)' \
  -e "tell application \"iTerm\" to tell current session of b to write text \"cd $PWD && agentbox dashboard web\""
# resize the new window for a compact frame:
osascript -e 'tell application "iTerm" to set bounds of front window to {40, 80, 1320, 600}'
# /clear the claude pane (removes the startup warning); then list-windows -> capture the AgentBox window id -> crop bottom ~8%.
```

**`claude-tui.png`** → run-an-agent, cli. The hero `agentbox claude -n web` window
(Claude Code TUI inside the box). `/clear` first; capture by window id; crop.

**`cursor.png`** → access-your-box (Cursor / Dev Containers). 

```bash
agentbox code web                 # opens Cursor attached to the box's /workspace
python3 .claude/skills/screenshot/scripts/take_screenshot.py --mode temp --app "Cursor"
# crop window chrome as needed
```

**`push-approval.png`** (best-effort) → sync-and-git. Trigger a push from inside the
box (`agentbox-ctl git push`) so the **host** shows the approval prompt; capture
that terminal window.

### Phase D — Diagrams (TODO — draw separately, not from the environment)

These are illustrations, not screenshots. Draw on-brand (paper `#f6f6f3`, ink
`#16181c`, accent `#128a4f`, IBM Plex). Save under `public/screenshots/` (or
`public/diagrams/`) and add `src=` to the figure.

- **core-concepts** — one box per agent run; credentials + git stay on the host; boxes call back through the relay.
- **configuration** — config layer precedence: CLI > workspace > project > global > committed defaults > built-in.
- **services-and-tasks** — the `needs` DAG: install → migrate; db runs in parallel; web waits on both.
- **sync-and-git** — commits land in the shared host repo instantly; only network ops route through the relay.
- **teleport-a-project** — host repo → box on its own `agentbox/<name>` branch; the host checkout is untouched.

### Phase E — External / manual (you)

- **`hetzner-token.png`** → hetzner. Log into the Hetzner Cloud console →
  Security → API Tokens → the "Read & Write" token creation page. Screenshot and
  crop to the panel.

---

## Wiring an image in

Once a PNG is in `apps/web/public/screenshots/`, add `src` to its figure (keep the
caption):

```mdx
<Figure src="/screenshots/<name>.png" caption="…" />
```

`agentbox build` (or `pnpm --filter @agentbox/web build`) should stay green and the
image serves at `/screenshots/<name>.png`.
