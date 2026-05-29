import { describe, expect, it } from 'vitest';
import {
  CLAUDE_SKIP_PERMISSIONS_FLAG,
  CODEX_SKIP_PERMISSIONS_FLAG,
  applyClaudeSkipPermissions,
  applyCodexSkipPermissions,
} from '../src/lib/skip-permissions.js';
import type { EffectiveConfig } from '@agentbox/config';

const cfg = (claudeOn: boolean, codexOn: boolean): EffectiveConfig =>
  ({
    claude: { dangerouslySkipPermissions: claudeOn },
    codex: { dangerouslySkipPermissions: codexOn },
  }) as unknown as EffectiveConfig;

describe('applyClaudeSkipPermissions', () => {
  it('prepends the flag when enabled and no conflicting arg is present', () => {
    expect(applyClaudeSkipPermissions(['-p', 'hi'], cfg(true, false))).toEqual([
      CLAUDE_SKIP_PERMISSIONS_FLAG,
      '-p',
      'hi',
    ]);
  });

  it('does nothing when the config disables it', () => {
    expect(applyClaudeSkipPermissions(['-p', 'hi'], cfg(false, false))).toEqual(['-p', 'hi']);
  });

  it('respects an explicit --permission-mode (space syntax)', () => {
    const args = ['--permission-mode', 'plan'];
    expect(applyClaudeSkipPermissions(args, cfg(true, false))).toEqual(args);
  });

  it('respects an explicit --permission-mode=plan (inline syntax)', () => {
    const args = ['--permission-mode=plan'];
    expect(applyClaudeSkipPermissions(args, cfg(true, false))).toEqual(args);
  });
});

describe('applyCodexSkipPermissions', () => {
  it('prepends the bypass flag when enabled', () => {
    expect(applyCodexSkipPermissions(['hi'], cfg(false, true))).toEqual([
      CODEX_SKIP_PERMISSIONS_FLAG,
      'hi',
    ]);
  });

  it('respects an explicit --ask-for-approval=never (inline syntax)', () => {
    const args = ['--ask-for-approval=never'];
    expect(applyCodexSkipPermissions(args, cfg(false, true))).toEqual(args);
  });

  it('respects a short -a approval flag', () => {
    const args = ['-a', 'never'];
    expect(applyCodexSkipPermissions(args, cfg(false, true))).toEqual(args);
  });
});
