// Re-export from the canonical source. The keystroke DSL parser lives in
// the CLI library (`apps/cli/src/lib/drive/keys.ts`) so both the runtime
// `agentbox drive` command and this test harness share one implementation.
export { parseKeys, parseKeysList } from '../../src/lib/drive/keys.js';
