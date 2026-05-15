import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Per-file isolated HOME — vitest runs this setup file before the test file's
// static imports evaluate, so the HOME-derived constants in @agentbox/config
// (GLOBAL_CONFIG_FILE, PROJECTS_DIR) point inside this temp dir.
const tempHome = mkdtempSync(join(tmpdir(), 'agentbox-cfg-home-'));
process.env['HOME'] = tempHome;
