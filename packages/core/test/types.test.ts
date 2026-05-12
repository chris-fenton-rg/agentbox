import { describe, expect, it } from 'vitest';
import type { BoxDescriptor, SandboxProvider } from '../src/index.js';

describe('@agentbox/core', () => {
  it('SandboxProvider interface accepts a stub implementation', () => {
    const stub: Pick<SandboxProvider, 'name' | 'list'> = {
      name: 'stub',
      async list(): Promise<BoxDescriptor[]> {
        return [];
      },
    };
    expect(stub.name).toBe('stub');
  });
});
