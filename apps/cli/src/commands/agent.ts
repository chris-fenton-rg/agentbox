import { log } from '@clack/prompts';
import {
  BOX_STATUS_EVENT,
  type BoxStatus,
  type BoxStatusClaude,
} from '@agentbox/ctl';
import { readBoxStatus } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import {
  AGENT_WAIT_STATES,
  derivedAgentState,
  isAgentWaitState,
  matchesAgentWaitState,
  type AgentWaitState,
} from '../lib/wait/agent-state.js';
import { waitForEvent, WaitTimeoutError } from '../lib/wait/events.js';
import { handleLifecycleError } from './_errors.js';

const DEFAULT_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

export const agentCommand = new Command('agent').description(
  'Query and wait on the in-box coding agent\'s state (Claude Code plan-mode end, AskUserQuestion, idle/prompt-ready).',
);

interface BoxRefOpts {
  json?: boolean;
}

const agentStateCommand = new Command('state')
  .description('Print the current claude activity state for a box (or full status with --json).')
  .argument('[box]', 'box ref (default: only box in this project)')
  .option('--json', 'emit the full BoxStatusClaude payload as JSON')
  .action(async (boxRef: string | undefined, opts: BoxRefOpts) => {
    try {
      const box = await resolveBoxOrExit(boxRef);
      const status = await readBoxStatus(box);
      const claude = status?.claude;
      if (opts.json === true) {
        process.stdout.write(JSON.stringify(claude ?? null) + '\n');
        return;
      }
      if (!claude) {
        log.info('no status snapshot yet for this box (hooks may not have fired)');
        return;
      }
      process.stdout.write(statusDisplay(claude) + '\n');
    } catch (err) {
      handleLifecycleError(err);
    }
  });

interface WaitForOpts {
  timeout?: string;
  json?: boolean;
}

const agentWaitForCommand = new Command('wait-for')
  .description(`Block until the agent reaches a state. One of: ${AGENT_WAIT_STATES.join(' | ')}.`)
  .argument('<state>', `target state: ${AGENT_WAIT_STATES.join(' | ')}`)
  .argument('[box]', 'box ref (default: only box in this project)')
  .option('--timeout <ms>', `wall-clock cap (default: ${String(DEFAULT_WAIT_TIMEOUT_MS)})`)
  .option('--json', 'emit the matched claude payload as JSON')
  .action(async (state: string, boxRef: string | undefined, opts: WaitForOpts) => {
    try {
      if (!isAgentWaitState(state)) {
        log.error(`unknown state '${state}' (one of: ${AGENT_WAIT_STATES.join(', ')})`);
        process.exit(2);
      }
      const target: AgentWaitState = state;
      const box = await resolveBoxOrExit(boxRef);
      const timeoutMs =
        opts.timeout !== undefined ? parsePositiveInt(opts.timeout, '--timeout') : DEFAULT_WAIT_TIMEOUT_MS;

      // Fast path: maybe the box is already in the target state.
      const current = await readBoxStatus(box);
      if (current?.claude && matchesAgentWaitState(current.claude, target)) {
        emitMatch(current.claude, opts.json === true);
        return;
      }

      // Subscribe to relay events. Filter to box-status events for this box,
      // re-check on each push.
      try {
        const claude = await waitForEvent<BoxStatusClaude>(
          (ev) => {
            if (ev.boxId !== box.id) return undefined;
            if (ev.type !== BOX_STATUS_EVENT) return undefined;
            const payload = ev.payload as BoxStatus | undefined;
            if (!payload?.claude) return undefined;
            return matchesAgentWaitState(payload.claude, target) ? payload.claude : undefined;
          },
          { boxId: box.id, timeoutMs },
        );
        emitMatch(claude, opts.json === true);
      } catch (err) {
        if (err instanceof WaitTimeoutError) {
          if (opts.json === true) {
            process.stdout.write(
              JSON.stringify({ matched: false, elapsedMs: err.elapsedMs }) + '\n',
            );
          } else {
            log.error(`agent did not reach '${target}' within ${String(timeoutMs)}ms`);
          }
          process.exit(1);
        }
        throw err;
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const agentGetPlanQuestionCommand = new Command('get-plan-question')
  .description("Print the active ExitPlanMode plan body or AskUserQuestion content (whichever is current).")
  .argument('[box]', 'box ref (default: only box in this project)')
  .option('--json', 'emit the structured payload as JSON instead of a human render')
  .action(async (boxRef: string | undefined, opts: BoxRefOpts) => {
    try {
      const box = await resolveBoxOrExit(boxRef);
      const status = await readBoxStatus(box);
      const claude = status?.claude;
      if (opts.json === true) {
        const out = claude?.plan ?? claude?.question ?? null;
        process.stdout.write(JSON.stringify(out) + '\n');
        return;
      }
      if (claude?.plan) {
        process.stdout.write(claude.plan.plan + '\n');
        return;
      }
      if (claude?.question) {
        for (const q of claude.question.questions) {
          process.stdout.write(`${q.question}\n`);
          for (const o of q.options) {
            process.stdout.write(`  - ${o.label}${o.description ? ` — ${o.description}` : ''}\n`);
          }
        }
        return;
      }
      log.info('no pending plan or question for this box');
      process.exit(1);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

agentCommand.addCommand(agentStateCommand);
agentCommand.addCommand(agentWaitForCommand);
agentCommand.addCommand(agentGetPlanQuestionCommand);

function emitMatch(claude: BoxStatusClaude, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(JSON.stringify(claude) + '\n');
  } else {
    process.stdout.write(derivedAgentState(claude) + '\n');
  }
}

function statusDisplay(claude: BoxStatusClaude): string {
  return derivedAgentState(claude);
}

function parsePositiveInt(raw: string, label: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || String(n) !== raw.trim()) {
    throw new Error(`${label} must be a positive integer (got: ${raw})`);
  }
  return n;
}
