export type ServiceState = 'starting' | 'running' | 'crashed' | 'backoff' | 'stopped';

export interface ServiceStatus {
  name: string;
  state: ServiceState;
  pid: number | null;
  restarts: number;
  lastExitCode: number | null;
  startedAt: string | null;
  nextRetryAt: string | null;
  command: string;
}

export interface LogEvent {
  service: string;
  ts: string;
  stream: 'stdout' | 'stderr';
  line: string;
}

export interface ReloadResult {
  added: string[];
  removed: string[];
  changed: string[];
}

export type CtlRequest =
  | { op: 'status' }
  | { op: 'logs'; service: string; tail?: number; follow?: boolean }
  | { op: 'restart'; service: string }
  | { op: 'stop'; service: string }
  | { op: 'start'; service: string }
  | { op: 'reload' }
  | { op: 'ping' }
  | { op: 'claude-session'; sessionName?: string };

export type CtlResponse = { ok: true; data: unknown } | { ok: false; error: string };

/**
 * Status of the in-container tmux session running Claude Code. The daemon
 * doesn't own this session lifecycle — it probes via `tmux has-session` and
 * `tmux display-message`. Missing tmux server / missing session both surface
 * as `running: false`.
 */
export interface ClaudeSessionStatus {
  running: boolean;
  sessionName: string;
  /** ISO-8601 timestamp from tmux's `#{session_created}`, or null when not running. */
  startedAt: string | null;
}

export const DEFAULT_SOCKET_PATH = '/run/agentbox/ctl.sock';
export const DEFAULT_CONFIG_PATH = '/workspace/agentbox.yaml';
export const DEFAULT_LOG_DIR = '/var/log/agentbox';
export const DEFAULT_CLAUDE_SESSION_NAME = 'claude';
