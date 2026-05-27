// Long-poll subscription to the host relay's `/admin/events` ring buffer.
// Used by `agentbox agent wait-for` and `agentbox queue wait-for` to block on
// state transitions without inventing a new endpoint. Polling is fine here:
// the relay buffers 1000 events in memory, and the cursor-based query is
// dependency-free (plain GET).

import { ensureRelay } from '@agentbox/sandbox-docker';

const POLL_INTERVAL_MS = 500;

export interface RelayEvent {
  id: number;
  boxId: string;
  type: string;
  receivedAt: string;
  ts?: string;
  payload?: unknown;
}

export interface SubscribeOptions {
  /** Filter to a single box id (else all). */
  boxId?: string;
  /** Wall-clock cap. Throws AbortError when reached. */
  timeoutMs?: number;
  /** Optional starting cursor; defaults to "current head" (skip historical events). */
  sinceId?: number;
}

export class WaitTimeoutError extends Error {
  constructor(public readonly elapsedMs: number) {
    super(`wait-for timed out after ${String(elapsedMs)}ms`);
    this.name = 'WaitTimeoutError';
  }
}

/**
 * Block until `predicate` returns truthy for one of the events streaming out
 * of `/admin/events`. The predicate's return value is what `waitForEvent`
 * resolves to — handy for "match + decode" in one step. Resolves to undefined
 * only if the predicate never returns truthy AND no timeout was set (which
 * means an infinite loop; callers should always pass `timeoutMs` in practice).
 */
export async function waitForEvent<T>(
  predicate: (ev: RelayEvent) => T | undefined,
  opts: SubscribeOptions = {},
): Promise<T> {
  const relayUrl = await getRelayUrl();
  const start = Date.now();
  let cursor = opts.sinceId ?? (await currentHeadCursor(relayUrl, opts.boxId));
  while (true) {
    const remaining = opts.timeoutMs !== undefined ? opts.timeoutMs - (Date.now() - start) : Infinity;
    if (remaining <= 0) throw new WaitTimeoutError(Date.now() - start);

    const events = await fetchEvents(relayUrl, cursor, opts.boxId);
    for (const ev of events) {
      const matched = predicate(ev);
      if (matched !== undefined) return matched;
      cursor = Math.max(cursor, ev.id);
    }
    // No match in this batch — sleep and re-poll (or wake early on timeout).
    const sleepMs = Math.min(POLL_INTERVAL_MS, remaining);
    if (sleepMs > 0) await sleep(sleepMs);
  }
}

async function fetchEvents(
  relayUrl: string,
  since: number,
  boxId: string | undefined,
): Promise<RelayEvent[]> {
  const url = new URL('/admin/events', relayUrl);
  url.searchParams.set('since', String(since));
  if (boxId) url.searchParams.set('box', boxId);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`relay /admin/events: HTTP ${String(res.status)}`);
  }
  const body = (await res.json()) as { events?: RelayEvent[] };
  return body.events ?? [];
}

/**
 * "Head" cursor — the id of the most recent event already in the buffer. New
 * `since=<head>` queries will only return strictly newer events, which is what
 * a freshly invoked `wait-for` wants (no replay of historical state changes).
 */
async function currentHeadCursor(relayUrl: string, boxId: string | undefined): Promise<number> {
  const events = await fetchEvents(relayUrl, 0, boxId);
  return events.length > 0 ? events[events.length - 1]!.id : 0;
}

async function getRelayUrl(): Promise<string> {
  // ensureRelay is idempotent: it spawns the host relay process if it's not
  // already running. `hostUrl` is the loopback view from this side; `url` is
  // the host.docker.internal view used inside boxes.
  const ep = await ensureRelay();
  return ep.hostUrl;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
