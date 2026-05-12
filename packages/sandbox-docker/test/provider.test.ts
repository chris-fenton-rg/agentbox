import { describe, expect, it } from 'vitest';
import { dockerProvider } from '../src/index.js';

describe('@agentbox/sandbox-docker', () => {
  it('exposes the docker provider name', () => {
    expect(dockerProvider.name).toBe('docker');
  });

  it('list() resolves to an empty array on a fresh host', async () => {
    await expect(dockerProvider.list()).resolves.toEqual([]);
  });

  it('start() throws not-implemented until the provider is built', async () => {
    await expect(
      dockerProvider.start({ workspacePath: '/tmp/x', agent: 'claude-code' }),
    ).rejects.toThrow(/not yet implemented/);
  });
});
