import type { SandboxProvider } from '@agentbox/core';

const notImplemented = (op: string): never => {
  throw new Error(`@agentbox/sandbox-docker: ${op} is not yet implemented`);
};

export const dockerProvider: SandboxProvider = {
  name: 'docker',
  async start() {
    return notImplemented('start');
  },
  async pause() {
    return notImplemented('pause');
  },
  async resume() {
    return notImplemented('resume');
  },
  async stop() {
    return notImplemented('stop');
  },
  async destroy() {
    return notImplemented('destroy');
  },
  async list() {
    return [];
  },
};
