---
description: Curate a CHANGELOG.md entry from commits since the last release; with a bump arg, also version, commit, push, and publish to npm
argument-hint: "[patch|minor|major]"
allowed-tools: Bash(git describe:*), Bash(git log:*), Bash(git tag:*), Bash(git rev-list:*), Bash(git rev-parse:*), Bash(git status:*), Bash(git add:*), Bash(git commit:*), Bash(git push:*), Bash(node:*), Bash(npm version:*), Bash(npm publish:*), Bash(npm view:*), Bash(cp:*), Bash(pnpm:*), Read, Edit
---

You are writing the next release-notes entry for `@madarco/agentbox`. The
changelog is at `apps/cli/CHANGELOG.md` (Keep a Changelog format). Produce
**short, user-facing notes — not a commit dump.**

## 1. Find the range

- Last release anchor: `git describe --tags --abbrev=0` (e.g. `v0.9.0`). If that
  fails (no tags), fall back to the last `New release` commit:
  `git log --grep='^New release$' -1 --pretty=%H`.
- The range is `<anchor>..HEAD`.

## 2. Gather material (not just subjects)

- `git log <anchor>..HEAD --no-merges --pretty=format:'===%h %s%n%b'` — read the
  **bodies**, they carry the real "why".
- `git log <anchor>..HEAD --stat --oneline` — gauge surface area.
- If a commit message is thin but the diff looks user-visible, inspect it with
  `git log -1 -p <hash> -- <path>`.

## 3. Curate — this is the point

- **Drop noise:** merge commits, CI / typecheck / lint / bugbot fixes, version
  bumps, and internal refactors or doc/copy tweaks with no user-visible effect.
- **Merge related commits** into a single bullet (e.g. several `feat(vercel)` /
  `fix(cloud)` commits → one "Vercel provider" line). Aim for a handful of
  bullets per heading, not one per commit.
- **Group** under these headings, in this order, omitting any that are empty:
  `### Breaking`, `### Added`, `### Changed`, `### Fixed`, `### Removed`.
- **Rewrite for a CLI user:** what changed for someone running `agentbox`, terse,
  past tense, no commit hashes. Mention the flag / config key / command name when
  relevant. Call out anything that breaks existing scripts under Breaking.

## 4. Pick the version

- Decide the bump from the commits: any breaking change → minor while pre-1.0
  (note it under Breaking), any `feat` → minor, else patch. Compute the next
  version from the current `apps/cli/package.json` `version`.
- If `$ARGUMENTS` names a bump (`patch` / `minor` / `major`), use that instead.

## 5. Write it

- Read `apps/cli/CHANGELOG.md`, then **prepend** a new section directly under the
  intro, above the most recent existing version:

  ```
  ## [<next-version>] - <today's date, YYYY-MM-DD>

  ### Added
  - ...
  ```

  Use today's real date — get it from the environment context, do not invent one.
- Print the entry you wrote.

## 6. Release (only when `$ARGUMENTS` named a bump)

If `$ARGUMENTS` did **not** name a bump (`patch` / `minor` / `major`), stop here so
the user can review and edit the changelog before releasing — do not bump or push.

Otherwise continue. **This publishes to a public registry and is irreversible**, so
get the user's explicit go-ahead at step 6.4 before publishing.

1. **Bump `package.json` (no commit, no tag yet).** Section 5 just edited the
   changelog, so the tree is dirty and a plain `npm version` would abort with
   `EGITDIRTYWORKINGDIR`. Bump the version field only, from the package dir:
   `cd apps/cli && npm version <bump> --no-git-tag-version`
   (this is the version you already wrote into the changelog heading).

2. **Commit the changelog + bump together, and tag.** One commit:
   ```
   git add apps/cli/CHANGELOG.md apps/cli/package.json
   git commit -m "release: v<next-version>"
   git tag v<next-version>
   ```
   (Stage whatever actually changed — add the root `CHANGELOG.md` too if you edited it.)

3. **Push the commit and tag.** Check the current branch first (`git rev-parse
   --abbrev-ref HEAD`). If it is not `main`, tell the user and confirm they want to
   release from this branch. Then: `git push --follow-tags`.

4. **Confirm before publishing.** Restate package (`@madarco/agentbox`), the new
   version, and the branch. Verify the version is not already on the registry
   (`npm view @madarco/agentbox@<next-version> version` should print nothing). Get
   an explicit go-ahead.

5. **Publish and surface the MFA link.** From the package dir (`prepublishOnly`
   rebuilds the whole workspace first, so this also runs the full build):
   `cd apps/cli && npm publish --auth-type=web`
   - With 2FA enabled, npm prints a web-auth URL:
     ```
     npm notice Authenticate your account at:
     npm notice https://www.npmjs.com/auth/cli/XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX
     ```
     **Show that full URL to the user immediately and prominently** ("Open this to
     authorize the publish: <url>"). Keep the command running in the **foreground** —
     npm completes the publish automatically once the browser approval lands. Do not
     cancel or background it.
   - **Classic TOTP fallback:** if npm instead asks for a one-time password
     (`This operation requires a one-time password`), ask the user for the 6-digit
     code and re-run with `--otp=<code>`.

6. **Confirm success.** `npm view @madarco/agentbox version` should now show
   <next-version>. Report the published version, the pushed tag, and the commit. If
   `npm publish` fails (already-published version, auth, build), report the exact
   error and stop — do not retry blindly.
