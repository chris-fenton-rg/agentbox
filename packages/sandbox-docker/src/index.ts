import type { SandboxProvider } from '@agentbox/core';

export {
  attachClaudeSession,
  buildClaudeMounts,
  ClaudeSessionError,
  claudeSessionInfo,
  DEFAULT_CLAUDE_SESSION,
  ensureClaudeVolume,
  resolveClaudeVolume,
  SHARED_CLAUDE_VOLUME,
  startClaudeSession,
  type ClaudeConfigSpec,
  type ClaudeMountResult,
  type ClaudeSessionInfo,
  type EnsureClaudeVolumeOptions,
  type EnsureClaudeVolumeResult,
  type StartClaudeSessionOptions,
} from './claude.js';
export { createBox, type CreateBoxOptions, type CreatedBox } from './create.js';
export { execInBox, type DockerExecResult } from './docker.js';
export { DEFAULT_BOX_IMAGE } from './image.js';
export { EXCLUDE_DIRS, SNAPSHOTS_ROOT, snapshotPathFor } from './snapshot.js';
export {
  STATE_DIR,
  STATE_FILE,
  findBox,
  readState,
  recordBox,
  removeBoxRecord,
  type BoxRecord,
  type FindBoxResult,
  type StateFile,
} from './state.js';
export { OverlayError, type OverlayCheck } from './overlay.js';
export {
  AmbiguousBoxError,
  BoxNotFoundError,
  destroyBox,
  inspectBox,
  listBoxes,
  pauseBox,
  pruneBoxes,
  snapshotPresent,
  startBox,
  stopBox,
  unpauseBox,
  type DestroyOptions,
  type DestroyResult,
  type InspectedBox,
  type ListedBox,
  type PruneOptions,
  type PruneResult,
  type StartedBox,
} from './lifecycle.js';

const notYet = (op: string): never => {
  throw new Error(`@agentbox/sandbox-docker: ${op} is not yet implemented`);
};

export const dockerProvider: SandboxProvider = {
  name: 'docker',
  async start(opts) {
    const { createBox } = await import('./create.js');
    const { record } = await createBox({
      workspacePath: opts.workspacePath,
      useSnapshot: false,
    });
    return {
      id: record.id,
      state: 'running',
      agent: opts.agent,
      workspacePath: record.workspacePath,
      createdAt: new Date(record.createdAt),
    };
  },
  async pause(id) {
    const { pauseBox } = await import('./lifecycle.js');
    await pauseBox(id);
  },
  async resume(id) {
    const { unpauseBox } = await import('./lifecycle.js');
    await unpauseBox(id);
  },
  async stop(id) {
    const { stopBox } = await import('./lifecycle.js');
    await stopBox(id);
  },
  async destroy(id) {
    const { destroyBox } = await import('./lifecycle.js');
    await destroyBox(id);
  },
  async list() {
    const { listBoxes } = await import('./lifecycle.js');
    const boxes = await listBoxes();
    return boxes.map((b) => ({
      id: b.id,
      state: b.state,
      agent: 'claude-code' as const,
      workspacePath: b.workspacePath,
      createdAt: new Date(b.createdAt),
    }));
  },
};

// notYet is no longer reachable from the public API. Keep it for now in case
// future provider methods need it before they're implemented.
void notYet;
