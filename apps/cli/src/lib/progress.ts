/**
 * `makeProgressReporter(verbose)` — small adapter around the clack spinner
 * that lets long-running commands (`create`, `claude`, `codex`,
 * `opencode`) opt into a `-v / --verbose` mode that bypasses the spinner
 * entirely and streams raw output to stderr.
 *
 * Without `--verbose` the returned object proxies a clack `spinner()`:
 *   - `start(label)`  → `s.start(label)`
 *   - `message(line)` → `s.message(clampSpinnerLine(line))`
 *   - `stop(label)`   → `s.stop(label)`
 *
 * With `--verbose` the spinner is never created. `start` / `stop` write a
 * single status line to stderr; `message` writes the raw, unclamped line
 * (preserving any newlines from the provider). This is the right mode
 * for the ~7-min cold cloud create where users want to see real progress.
 *
 * Either way, callers should still write every line to `cmdLog` so the
 * full transcript lands in `~/.agentbox/logs/<command>.log`. This helper
 * only handles the user-visible surface.
 */
import { spinner } from '@clack/prompts';
import { clampSpinnerLine } from '../spinner-line.js';

export interface ProgressReporter {
  start(label: string): void;
  message(line: string): void;
  stop(label: string): void;
}

export function makeProgressReporter(verbose: boolean): ProgressReporter {
  if (!verbose) {
    const s = spinner();
    return {
      start: (label) => s.start(label),
      message: (line) => s.message(clampSpinnerLine(line)),
      stop: (label) => s.stop(label),
    };
  }
  return {
    start: (label) => process.stderr.write(`${label} (verbose)\n`),
    message: (line) => process.stderr.write(line.endsWith('\n') ? line : line + '\n'),
    stop: (label) => process.stderr.write(`${label}\n`),
  };
}
