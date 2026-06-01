import { describe, expect, it } from 'vitest';
import {
  GH_PR_READ_ONLY_OPS,
  GH_RUN_READ_ONLY_OPS,
  injectPrCreateHead,
  isAllowedGhApiEndpoint,
  isGhPrOp,
  isGhRunOp,
  prCreateNeedsHead,
  refuseGhApiWrite,
} from '../src/gh.js';

describe('injectPrCreateHead', () => {
  it('prepends --head <branch> for create when none was passed', () => {
    expect(injectPrCreateHead('create', 'agentbox/box-one', ['--title', 'T'])).toEqual([
      '--head',
      'agentbox/box-one',
      '--title',
      'T',
    ]);
  });

  it('is a no-op for non-create ops', () => {
    expect(injectPrCreateHead('view', 'agentbox/box-one', ['7'])).toEqual(['7']);
    expect(injectPrCreateHead('merge', 'agentbox/box-one', ['42'])).toEqual(['42']);
  });

  it('does not double-inject when --head is already present', () => {
    expect(injectPrCreateHead('create', 'agentbox/box-one', ['--head', 'feat/x'])).toEqual([
      '--head',
      'feat/x',
    ]);
    expect(injectPrCreateHead('create', 'agentbox/box-one', ['--head=feat/x'])).toEqual([
      '--head=feat/x',
    ]);
  });

  it('does not double-inject when the -H shorthand is already present', () => {
    expect(injectPrCreateHead('create', 'agentbox/box-one', ['-H', 'feat/x'])).toEqual([
      '-H',
      'feat/x',
    ]);
    expect(injectPrCreateHead('create', 'agentbox/box-one', ['-Hfeat/x'])).toEqual(['-Hfeat/x']);
    expect(injectPrCreateHead('create', 'agentbox/box-one', ['-H=feat/x'])).toEqual(['-H=feat/x']);
  });

  it('leaves args unchanged when no usable branch resolved', () => {
    expect(injectPrCreateHead('create', undefined, ['--title', 'T'])).toEqual(['--title', 'T']);
    expect(injectPrCreateHead('create', '', ['--title', 'T'])).toEqual(['--title', 'T']);
    expect(injectPrCreateHead('create', 'HEAD', ['--title', 'T'])).toEqual(['--title', 'T']);
  });
});

describe('prCreateNeedsHead', () => {
  it('is true for a create that still has no --head', () => {
    expect(prCreateNeedsHead('create', ['--title', 'T'])).toBe(true);
    // After injectPrCreateHead failed to resolve a branch:
    expect(prCreateNeedsHead('create', injectPrCreateHead('create', '', ['--title', 'T']))).toBe(
      true,
    );
  });

  it('is false once --head is present (injected or caller-supplied)', () => {
    expect(prCreateNeedsHead('create', ['--head', 'agentbox/box-one', '--title', 'T'])).toBe(false);
    expect(prCreateNeedsHead('create', ['--head=feat/x'])).toBe(false);
    expect(
      prCreateNeedsHead('create', injectPrCreateHead('create', 'agentbox/box-one', ['--title', 'T'])),
    ).toBe(false);
  });

  it('is false when the -H shorthand supplied a head (no false refusal)', () => {
    expect(prCreateNeedsHead('create', ['-H', 'feat/x', '--title', 'T'])).toBe(false);
    expect(prCreateNeedsHead('create', ['-Hfeat/x'])).toBe(false);
    expect(prCreateNeedsHead('create', ['-H=feat/x'])).toBe(false);
  });

  it('is false for non-create ops', () => {
    expect(prCreateNeedsHead('view', ['7'])).toBe(false);
    expect(prCreateNeedsHead('merge', ['42'])).toBe(false);
  });
});

describe('gh pr diff / checks', () => {
  it('are recognized ops', () => {
    expect(isGhPrOp('diff')).toBe(true);
    expect(isGhPrOp('checks')).toBe(true);
  });

  it('are read-only (no prompt)', () => {
    expect(GH_PR_READ_ONLY_OPS.has('diff')).toBe(true);
    expect(GH_PR_READ_ONLY_OPS.has('checks')).toBe(true);
  });
});

describe('isGhRunOp', () => {
  it('accepts list / view / rerun', () => {
    expect(isGhRunOp('list')).toBe(true);
    expect(isGhRunOp('view')).toBe(true);
    expect(isGhRunOp('rerun')).toBe(true);
  });

  it('rejects watch and anything else', () => {
    expect(isGhRunOp('watch')).toBe(false);
    expect(isGhRunOp('cancel')).toBe(false);
    expect(isGhRunOp('')).toBe(false);
  });
});

describe('GH_RUN_READ_ONLY_OPS', () => {
  it('covers list / view but not rerun', () => {
    expect(GH_RUN_READ_ONLY_OPS.has('list')).toBe(true);
    expect(GH_RUN_READ_ONLY_OPS.has('view')).toBe(true);
    expect(GH_RUN_READ_ONLY_OPS.has('rerun')).toBe(false);
  });
});

describe('isAllowedGhApiEndpoint', () => {
  it('matches the PR comments endpoint with or without a leading slash', () => {
    expect(isAllowedGhApiEndpoint('/repos/o/r/pulls/5/comments')).toBe(true);
    expect(isAllowedGhApiEndpoint('repos/o/r/pulls/5/comments')).toBe(true);
  });

  it('allows a trailing GET query string', () => {
    expect(isAllowedGhApiEndpoint('repos/o/r/pulls/5/comments?per_page=50')).toBe(true);
  });

  it('rejects sibling / unrelated endpoints', () => {
    expect(isAllowedGhApiEndpoint('repos/o/r/issues/5/comments')).toBe(false);
    expect(isAllowedGhApiEndpoint('repos/o/r/pulls/5/merge')).toBe(false);
    expect(isAllowedGhApiEndpoint('repos/o/r/pulls/abc/comments')).toBe(false);
    expect(isAllowedGhApiEndpoint('user')).toBe(false);
    expect(isAllowedGhApiEndpoint('')).toBe(false);
  });
});

describe('refuseGhApiWrite', () => {
  it('passes read-only argv', () => {
    expect(refuseGhApiWrite([])).toBeNull();
    expect(refuseGhApiWrite(['--jq', '.[].body'])).toBeNull();
    expect(refuseGhApiWrite(['--paginate'])).toBeNull();
    expect(refuseGhApiWrite(['-X', 'GET'])).toBeNull();
    expect(refuseGhApiWrite(['--method=get'])).toBeNull();
  });

  it('refuses an explicit non-GET method', () => {
    expect(refuseGhApiWrite(['-X', 'POST'])?.exitCode).toBe(65);
    expect(refuseGhApiWrite(['--method', 'patch'])?.exitCode).toBe(65);
    expect(refuseGhApiWrite(['--method=DELETE'])?.exitCode).toBe(65);
  });

  it('refuses combined/glued short-flag method forms (pflag accepts them)', () => {
    expect(refuseGhApiWrite(['-XPOST'])?.exitCode).toBe(65);
    expect(refuseGhApiWrite(['-X=POST'])?.exitCode).toBe(65);
    // -XGET glued is still a read — must pass.
    expect(refuseGhApiWrite(['-XGET'])).toBeNull();
    expect(refuseGhApiWrite(['-X=get'])).toBeNull();
  });

  it('refuses field flags that auto-switch gh api to POST', () => {
    expect(refuseGhApiWrite(['-f', 'body=hi'])?.exitCode).toBe(65);
    expect(refuseGhApiWrite(['-F', 'in_reply_to=1'])?.exitCode).toBe(65);
    expect(refuseGhApiWrite(['--field', 'body=hi'])?.exitCode).toBe(65);
    expect(refuseGhApiWrite(['--raw-field=body=hi'])?.exitCode).toBe(65);
    expect(refuseGhApiWrite(['--input', '-'])?.exitCode).toBe(65);
  });

  it('refuses glued short-flag field forms (-fkey=val / -Fkey=val)', () => {
    expect(refuseGhApiWrite(['-fbody=hi'])?.exitCode).toBe(65);
    expect(refuseGhApiWrite(['-Fin_reply_to=1'])?.exitCode).toBe(65);
  });
});
