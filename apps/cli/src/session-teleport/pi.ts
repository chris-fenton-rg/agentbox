/**
 * pi session teleport — v1 stub. pi has rich native session support
 * (`pi --session-id <uuid>` create-or-resume, `pi -c` / `--continue`,
 * `pi -r` / `--resume`), and stores sessions as JSON under
 * `~/.pi/agent/sessions/`. A real host->box teleport is feasible — locate the
 * newest/by-id session, rewrite its cwd field to `/workspace`, upload it into
 * the box's `~/.pi/agent/sessions/` and prepend `--session-id` — but pi's
 * session-file schema + cwd encoding need to be pinned down first, so it is
 * tracked for a follow-up.
 *
 * For v1 we fail fast with a clear message. Note that pi's own `--continue` /
 * `--resume` still work *inside* a box across stop/start (the pi-config volume
 * persists the box's own sessions); only carrying a *host* session into a fresh
 * box is unsupported here.
 */

import { TeleportError } from './types.js';

export function resolvePiTeleport(): never {
  throw new TeleportError(
    'pi session teleport (carrying a host session into a fresh box) is not yet supported in agentbox; it is tracked for a follow-up. Run `agentbox pi` without -c / --resume to start a fresh session — pi can still resume the box-local session with `--continue` once inside the box.',
  );
}
