export interface HookFilterResult<T = unknown> {
  data: T;
  removedCommands: string[];
}

/**
 * Predicate for the filter: does `command` look like it points at a host path
 * outside the project, i.e. under the user's host home directory?
 *
 * Uses `.includes(hostHome + '/')` so we also catch shell-quoted forms like
 * `bash -c '/Users/marco/.config/iterm2/cc-status'`. The trailing slash gates
 * against false matches on similar-prefix home dirs (e.g. `/Users/marco`
 * shouldn't match `/Users/marco-other/...`).
 *
 * Returns false when `hostHome` is empty so we degrade safely if no home is
 * resolvable for some reason.
 */
export function isHostPathHookCommand(command: string, hostHome: string): boolean {
  if (typeof command !== 'string' || command.length === 0) return false;
  if (hostHome.length === 0) return false;
  return command.includes(hostHome + '/');
}

interface HookLeaf {
  type?: string;
  command?: string;
  [k: string]: unknown;
}

interface HookMatcherEntry {
  hooks?: unknown;
  [k: string]: unknown;
}

/**
 * Walk Claude Code's documented `hooks.<Trigger>[].hooks[]` structure and drop
 * any leaf `{ type: 'command', command: '<host-path>' }` whose `command` matches
 * {@link isHostPathHookCommand}. Empty `hooks: []` arrays and their matcher
 * wrappers are left intact — they don't break Claude and avoiding recursive
 * cleanup keeps the filter predictable.
 *
 * Returns a deep clone; input is not mutated. Tolerant of unexpected shapes
 * (string, number, null at any level): unrecognized branches pass through
 * unchanged, removed count stays accurate.
 */
export function filterHostHooks<T = unknown>(data: T, hostHome: string): HookFilterResult<T> {
  // structuredClone is in node >= 17; the repo targets node20, so this is safe.
  const clone = structuredClone(data) as unknown;
  const removedCommands: string[] = [];

  if (clone === null || typeof clone !== 'object' || Array.isArray(clone)) {
    return { data: clone as T, removedCommands };
  }

  const top = clone as { hooks?: unknown };
  const hooksRoot = top.hooks;
  if (hooksRoot === null || typeof hooksRoot !== 'object' || Array.isArray(hooksRoot)) {
    return { data: clone as T, removedCommands };
  }

  for (const triggerName of Object.keys(hooksRoot as Record<string, unknown>)) {
    const triggerValue = (hooksRoot as Record<string, unknown>)[triggerName];
    if (!Array.isArray(triggerValue)) continue;
    for (const entry of triggerValue) {
      if (entry === null || typeof entry !== 'object') continue;
      const matcher = entry as HookMatcherEntry;
      const inner = matcher.hooks;
      if (!Array.isArray(inner)) continue;
      // In-place filter on the cloned array.
      for (let i = inner.length - 1; i >= 0; i--) {
        const leaf = inner[i] as HookLeaf | null;
        if (leaf === null || typeof leaf !== 'object') continue;
        if (
          leaf.type === 'command' &&
          typeof leaf.command === 'string' &&
          isHostPathHookCommand(leaf.command, hostHome)
        ) {
          removedCommands.push(leaf.command);
          inner.splice(i, 1);
        }
      }
    }
  }

  return { data: clone as T, removedCommands };
}

export interface ClearInstallMethodResult<T = unknown> {
  data: T;
  cleared: boolean;
}

/**
 * Drop the top-level `installMethod` field from a parsed `~/.claude.json`.
 *
 * The host records how *the host* was installed (e.g. `"native"` on macOS,
 * `"npm-global"` for npm users). The box now uses the native installer, so
 * the field usually matches; but if a user's host recorded a different
 * value, it would clash with the box's binary location and trigger an
 * `installMethod is X, but <dir> does not exist` integrity warning.
 * Stripping the field defensively lets claude inside the box redetect.
 *
 * Returns a deep-cloned, scrubbed copy plus a flag indicating whether the
 * field was actually present. Input is not mutated.
 */
export function clearInstallMethod<T = unknown>(data: T): ClearInstallMethodResult<T> {
  const clone = structuredClone(data) as unknown;
  if (clone === null || typeof clone !== 'object' || Array.isArray(clone)) {
    return { data: clone as T, cleared: false };
  }
  const obj = clone as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(obj, 'installMethod')) {
    delete obj.installMethod;
    return { data: clone as T, cleared: true };
  }
  return { data: clone as T, cleared: false };
}
