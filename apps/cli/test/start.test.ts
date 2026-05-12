import { describe, expect, it } from 'vitest';
import { startCommand } from '../src/commands/start.js';

describe('agentbox start command', () => {
  it('is registered with the expected name', () => {
    expect(startCommand.name()).toBe('start');
  });

  it('declares the agent/provider/workspace options', () => {
    const flags = startCommand.options.map((o) => o.long);
    expect(flags).toContain('--agent');
    expect(flags).toContain('--provider');
    expect(flags).toContain('--workspace');
  });
});
