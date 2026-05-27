// AgentBox state-reporting plugin for OpenCode (sst/opencode).
//
// Subscribes to OpenCode's plugin event bus and reports each lifecycle
// transition to `agentbox-ctl opencode-state <state>`. The ctl daemon then
// publishes the state to the host relay's status.json, which is what
// `agentbox agent state` / `agent wait-for` consume on the host side.
//
// Fire-and-forget — a missing/late `agentbox-ctl` must never disturb the
// OpenCode session. The spawned process is detached + unrefed so a slow
// ctl response never blocks an event handler.
//
// Seeded by `seedOpencodePlugin` (packages/sandbox-docker/src/opencode.ts)
// from the image-baked copy at /usr/local/share/agentbox/opencode-plugin/
// into the box's `$OPENCODE_CONFIG_DIR/plugins/agentbox-state.js` on every
// create / start. Idempotent overwrite.
//
// Event coverage (mirrors the Claude / Codex state machine):
//   working   — codex/claude equivalent of "agent is generating"
//   idle      — turn complete, ready for input (mapped from session.idle and
//               session.created baseline)
//   waiting   — user input required (permission.asked)
//   error     — session.error fired
//   compacting — session.compacted (note: opencode fires AFTER compaction
//                finishes, so we briefly flag and then the next event
//                supersedes; semantically "context was just compacted")
//
// The plugin shape comes from https://opencode.ai/docs/plugins/ — `event` is
// a single handler that receives `{ event }` with a `type` field. Multiple
// exports = multiple plugin functions; we ship one.

import { spawn } from 'node:child_process';

const EVENT_TO_STATE = {
  'session.created': 'idle',
  'session.idle': 'idle',
  'session.compacted': 'working',
  'session.error': 'error',
  'permission.asked': 'waiting',
  'permission.replied': 'working',
  'tool.execute.before': 'working',
  // tool.execute.after intentionally omitted — the next event will set the
  // appropriate state. Pushing `working` here would cause a working → idle
  // → working flicker on a normal turn.
};

function pushState(state) {
  if (!state) return;
  try {
    const p = spawn('agentbox-ctl', ['opencode-state', state], {
      stdio: 'ignore',
      detached: true,
    });
    p.unref();
  } catch {
    // Fire-and-forget. A missing agentbox-ctl bin (test env, older box image)
    // must not throw out of this handler.
  }
}

export const AgentboxStatePlugin = async () => ({
  event: async ({ event }) => {
    const state = EVENT_TO_STATE[event?.type];
    pushState(state);
  },
});
