export type BoxId = string;

export type BoxState = 'running' | 'paused' | 'stopped' | 'destroyed';

export type AgentKind = 'claude-code' | 'codex' | (string & {});

export interface BoxDescriptor {
  id: BoxId;
  state: BoxState;
  agent: AgentKind;
  workspacePath: string;
  createdAt: Date;
}

export interface StartBoxOptions {
  workspacePath: string;
  agent: AgentKind;
}

export interface SandboxProvider {
  readonly name: string;
  start(opts: StartBoxOptions): Promise<BoxDescriptor>;
  pause(id: BoxId): Promise<void>;
  resume(id: BoxId): Promise<void>;
  stop(id: BoxId): Promise<void>;
  destroy(id: BoxId): Promise<void>;
  list(): Promise<BoxDescriptor[]>;
}
