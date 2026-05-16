import { describe, expect, it } from 'vitest';
import {
  CHECKPOINT_VOLUME_PREFIX,
  checkpointVolumeName,
  computeNextCheckpointName,
} from '../src/checkpoint.js';

describe('checkpointVolumeName', () => {
  it('is deterministic, prefixed, and one volume per project', () => {
    const a = checkpointVolumeName('/Users/x/proj-a');
    const b = checkpointVolumeName('/Users/x/proj-b');
    expect(a).toBe(checkpointVolumeName('/Users/x/proj-a')); // deterministic
    expect(a).not.toBe(b); // scoped per project root
    expect(a.startsWith(CHECKPOINT_VOLUME_PREFIX)).toBe(true);
  });

  it('produces a Docker-volume-name-safe string (no path separators)', () => {
    const v = checkpointVolumeName('/Users/x/My Project (weird)/sub');
    expect(v).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
  });
});

describe('computeNextCheckpointName', () => {
  it('starts at 1 when no checkpoints exist for the box', () => {
    expect(computeNextCheckpointName([], 'warm')).toBe('warm-1');
    expect(computeNextCheckpointName(['other-1', 'other-2'], 'warm')).toBe('warm-1');
  });

  it('is max+1, never recycling gaps from deleted checkpoints', () => {
    expect(computeNextCheckpointName(['warm-1', 'warm-2'], 'warm')).toBe('warm-3');
    // warm-2 deleted -> still 3, the gap is not reused.
    expect(computeNextCheckpointName(['warm-1', 'warm-3'], 'warm')).toBe('warm-4');
  });

  it('scopes the counter to the exact box name', () => {
    expect(computeNextCheckpointName(['warm-1', 'warmer-9'], 'warm')).toBe('warm-2');
    expect(computeNextCheckpointName(['warm-1', 'warmer-9'], 'warmer')).toBe('warmer-10');
  });

  it('treats a box name with regex metacharacters literally', () => {
    expect(computeNextCheckpointName(['a.b-1', 'aXb-5'], 'a.b')).toBe('a.b-2');
  });

  it('ignores non-numeric suffixes', () => {
    expect(computeNextCheckpointName(['warm-foo', 'warm-1'], 'warm')).toBe('warm-2');
  });
});
