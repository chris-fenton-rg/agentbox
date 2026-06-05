import { log } from '@clack/prompts';
import {
  BOX_STATUS_EVENT,
  type BoxStatus,
  type BoxStatusClaude,
} from '@agentbox/ctl';
import type { PromptAskEvent } from '@agentbox/relay';
import { ensureRelay, readBoxStatus } from '@agentbox/sandbox-docker';
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

interface ApprovalsOpts {
  json?: boolean;
  wait?: string;
}

const agentApprovalsCommand = new Command('approvals')
  .description(
    'List pending host-action approvals for a box (git push, cp host<->box, gh PR writes, checkpoint). ' +
      'These are the relay confirms an unattended orchestrator answers with `agent approve`.',
  )
  .argument('[box]', 'box ref (default: only box in this project)')
  .option('--json', 'emit the pending approvals as a JSON array')
  .option(
    '--wait <ms>',
    'block until at least one approval is pending (or this wall-clock cap elapses), then print',
  )
  .action(async (boxRef: string | undefined, opts: ApprovalsOpts) => {
    try {
      const box = await resolveBoxOrExit(boxRef);
      const relayUrl = (await ensureRelay()).hostUrl;
      const waitMs =
        opts.wait !== undefined ? parsePositiveInt(opts.wait, '--wait') : undefined;

      let pending = await fetchApprovals(relayUrl, box.id);
      if (waitMs !== undefined && pending.length === 0) {
        const start = Date.now();
        while (pending.length === 0 && Date.now() - start < waitMs) {
          await sleep(Math.min(500, waitMs - (Date.now() - start)));
          pending = await fetchApprovals(relayUrl, box.id);
        }
      }

      if (opts.json === true) {
        process.stdout.write(JSON.stringify(pending.map(approvalToJson)) + '\n');
        return;
      }
      if (pending.length === 0) {
        log.info('no pending host-action approvals for this box');
        return;
      }
      for (const ev of pending) {
        process.stdout.write(approvalDisplay(ev) + '\n');
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });

interface ApproveOpts {
  deny?: boolean;
  cancel?: boolean;
}

const agentApproveCommand = new Command('approve')
  .description(
    'Answer a pending host-action approval by id (see `agent approvals`). Approves by default; ' +
      '--deny rejects, --cancel dismisses (both resolve the box RPC as denied).',
  )
  .argument('<id>', 'approval id from `agent approvals`')
  .option('--deny', 'reject the host action instead of approving it')
  .option('--cancel', 'dismiss the approval (treated as denied; marks it cancelled)')
  .action(async (id: string, opts: ApproveOpts) => {
    try {
      const relayUrl = (await ensureRelay()).hostUrl;
      const cancelled = opts.cancel === true;
      const answer: 'y' | 'n' = opts.deny === true || cancelled ? 'n' : 'y';
      const url = new URL('/admin/prompts/answer', relayUrl);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, answer, cancelled: cancelled || undefined }),
      });
      // 204 = resolved; 404 = already answered/expired (idempotent — the
      // orchestrator treats both as "done").
      if (res.status === 204) {
        log.success(`approval ${id}: ${answer === 'y' ? 'approved' : 'denied'}`);
        return;
      }
      if (res.status === 404) {
        log.info(`approval ${id} already resolved (or expired)`);
        return;
      }
      log.error(`relay /admin/prompts/answer: HTTP ${String(res.status)}`);
      process.exit(1);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

agentCommand.addCommand(agentStateCommand);
agentCommand.addCommand(agentWaitForCommand);
agentCommand.addCommand(agentGetPlanQuestionCommand);
agentCommand.addCommand(agentApprovalsCommand);
agentCommand.addCommand(agentApproveCommand);

async function fetchApprovals(relayUrl: string, boxId: string): Promise<PromptAskEvent[]> {
  const url = new URL('/admin/prompts', relayUrl);
  url.searchParams.set('boxId', boxId);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`relay /admin/prompts: HTTP ${String(res.status)}`);
  const body = (await res.json()) as { prompts?: PromptAskEvent[] };
  return body.prompts ?? [];
}

function approvalToJson(ev: PromptAskEvent): Record<string, unknown> {
  return {
    id: ev.id,
    command: ev.context?.command,
    argv: ev.context?.argv,
    cwd: ev.context?.cwd,
    message: ev.message,
    detail: ev.detail,
    defaultAnswer: ev.defaultAnswer,
  };
}

function approvalDisplay(ev: PromptAskEvent): string {
  const cmd = ev.context?.command ?? ev.message;
  const argv = ev.context?.argv?.length ? `  ${ev.context.argv.join(' ')}` : '';
  const detail = ev.detail ? `  (${ev.detail})` : '';
  return `${ev.id}  ${cmd}${argv}${detail}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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
