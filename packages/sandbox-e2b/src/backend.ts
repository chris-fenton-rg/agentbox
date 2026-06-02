/**
 * E2B `CloudBackend` — maps the provider-neutral cloud primitives onto the
 * `e2b` v2 SDK (Firecracker microVMs + pause/resume persistence). Composed
 * into a full `Provider` by `@agentbox/sandbox-cloud`'s `createCloudProvider`.
 *
 * Platform shape this backend is built around:
 *   - The default `base` template is a vanilla Debian 12 microVM. It ships
 *     node 20, bash, git, sudo, but NOT `agentbox-ctl`, NOT a `vscode` user,
 *     and NOT a `/workspace` dir. `provision()` performs a one-shot create-
 *     time "fixup" — upload the ctl bundle + create the vscode user + chown
 *     `/workspace` — so the rest of the cloud scaffold's hardcoded
 *     `vscode`/`/usr/local/bin/agentbox-ctl`/`/workspace` references work.
 *     Task 2 will replace this with a baked custom template via
 *     `e2b template build` (`agentbox prepare --provider e2b`).
 *   - No nested containers (Firecracker microVM); the provider sets
 *     `launchDockerd: false`.
 *   - Preview URLs (`sandbox.getHost(port)`) are public HTTPS by default
 *     (allowPublicTraffic=true); no header token needed. Same shape as Vercel.
 *   - `Sandbox.getInfo` is a NON-resuming static API; `state()`/`get()` use it
 *     to check existence cheaply without waking a paused sandbox. Auto-resume
 *     happens only inside `Sandbox.connect` (used by ops that need a live
 *     handle: exec, file ops, pause, destroy).
 *   - `Sandbox.pause` is the canonical pause API (`betaPause` is deprecated).
 *   - No SSH — `attachArgv` is intentionally omitted; the cloud scaffold's
 *     exec-driven tmux pump is used for `agentbox shell` until Task 2 ships
 *     a SDK-streaming attach helper.
 */

import { readFile } from 'node:fs/promises';
import type {
  CloudBackend,
  CloudExecOptions,
  CloudExecResult,
  CloudFileEntry,
  CloudHandle,
  CloudPreviewUrl,
  CloudProvisionRequest,
  CloudSandboxSummary,
  CloudState,
} from '@agentbox/core';
import type { SandboxInfo, SandboxState } from './sdk.js';
import { Sandbox, resolveApiKey } from './sdk.js';
import { withE2bRetry } from './retry.js';
import { resolveRuntimeAssets, findStagedCliRuntimeRoot } from './runtime-assets.js';

/**
 * Sentinel image ref the cloud-provider hands us when no --image was passed.
 * Mirrors docker's docker-image ref convention so callers can pass `--image`
 * a Vercel/Daytona-style ref (or leave it default to boot from E2B's `base`).
 * Task 2 will swap this for the baked template id from `~/.agentbox/e2b-prepared.json`.
 */
export const DEFAULT_BOX_IMAGE_REF = 'agentbox/box:dev';
/** E2B's public default template — boots fast, has node 20 + git + sudo. */
const E2B_BASE_TEMPLATE = 'base';

/** Box user agentbox standardizes on (matches docker/vercel — created in the fixup script). */
const BOX_USER = 'vscode';
const BOX_OWNER = 'vscode:vscode';

/**
 * Per-box session timeout the SDK enforces. Past it, E2B auto-terminates the
 * sandbox; we explicitly extend via `sb.setTimeout` is not needed for Task 1's
 * smoke (boxes survive minutes, not hours). 45 min default mirrors vercel.
 */
const DEFAULT_TIMEOUT_MS = 45 * 60_000;

const E2B_WEB_PORT = 8080;

/** Single-quote a string for safe embedding inside a `bash -lc '<…>'`. */
function shq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Convert a Node `Buffer` to a plain `ArrayBuffer` because E2B's `files.write`
 * `data:` field is `string | ArrayBuffer | Blob | ReadableStream` — Buffer is a
 * `Uint8Array` subclass and doesn't satisfy that union at the type level (even
 * though it works at runtime). Copy rather than slice the underlying buffer:
 * Buffers may share an underlying ArrayBuffer with a pooled allocator, so
 * `data.buffer` of a small Buffer can be a megabyte-long shared region.
 */
function bufferToArrayBuffer(b: Buffer): ArrayBuffer {
  const ab = new ArrayBuffer(b.byteLength);
  new Uint8Array(ab).set(b);
  return ab;
}

/**
 * Map the SDK's nullable string state onto our 4-value `CloudState`.
 * E2B reports 'running' | 'paused' (per SDK types). Anything else (or absent)
 * → 'missing' so callers ping-pong the lifecycle into a clean state.
 */
function mapState(s: SandboxState | undefined): CloudState {
  switch (s) {
    case 'running':
      return 'running';
    case 'paused':
      return 'paused';
    default:
      return 'missing';
  }
}

/** True when the error means "sandbox doesn't exist" (404). */
function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = err instanceof Error ? err.name : '';
  if (name === 'SandboxNotFoundError' || name === 'NotFoundError') return true;
  const status = (err as { statusCode?: unknown; status?: unknown }).statusCode ?? (err as { status?: unknown }).status;
  return status === 404;
}

/**
 * Build the per-box fixup script that runs once at create-time to make the
 * vanilla E2B base template look like the cloud scaffold expects:
 *   - create the `vscode` user (uid auto-assigned — 1000 is taken by E2B's
 *     own `code` group on this template), grant passwordless sudo.
 *   - own `/workspace`, `/run/agentbox`, `/var/log/agentbox` so the ctl
 *     daemon (run as vscode) can write its socket + log file.
 *   - install the uploaded `agentbox-ctl` bundle to `/usr/local/bin` (where
 *     `launchCloudCtlDaemon` expects it). Idempotent on resume so the script
 *     can be re-run cheaply if needed.
 */
function buildFixupScript(): string {
  return [
    'set -e',
    'id -u vscode 2>/dev/null || sudo -n useradd -m -s /bin/bash vscode',
    "echo 'vscode ALL=(ALL) NOPASSWD: ALL' | sudo -n tee /etc/sudoers.d/agentbox-vscode > /dev/null",
    'sudo -n chmod 0440 /etc/sudoers.d/agentbox-vscode',
    'sudo -n mkdir -p /workspace /run/agentbox /var/log/agentbox',
    'sudo -n chown vscode:vscode /workspace /run/agentbox /var/log/agentbox',
    'sudo -n cp /tmp/agentbox-ctl /usr/local/bin/agentbox-ctl',
    'sudo -n chmod 0755 /usr/local/bin/agentbox-ctl',
    'rm -f /tmp/agentbox-ctl',
    'echo agentbox-fixup-ok',
  ].join('\n');
}

/**
 * Stage the runtime payload (just `agentbox-ctl` for Task 1) into the box and
 * run the fixup script. All `files.write` calls happen before any exec so the
 * vscode user / `/workspace` exist before the cloud scaffold's first exec.
 */
async function seedE2bRuntime(
  sb: InstanceType<typeof Sandbox>,
  log: (line: string) => void,
): Promise<void> {
  const assets = resolveRuntimeAssets({ cliRuntimeRoot: findStagedCliRuntimeRoot() });
  log(`e2b: uploading ${String(assets.length)} runtime asset(s)`);
  for (const a of assets) {
    const data = await readFile(a.localPath);
    await sb.files.write([{ path: a.remotePath, data: bufferToArrayBuffer(data) }]);
  }
  const script = buildFixupScript();
  await sb.files.write([{ path: '/tmp/agentbox-fixup.sh', data: script }]);
  // Run as the default user `user` (E2B base) — the script uses `sudo -n`
  // for the root-required steps. user already has passwordless sudo
  // (groups=user,sudo) per the probe.
  const r = await sb.commands.run('bash /tmp/agentbox-fixup.sh', { timeoutMs: 60_000 });
  if (r.exitCode !== 0) {
    throw new Error(
      `e2b fixup failed (exit ${String(r.exitCode)}): ${r.stderr || r.stdout}`,
    );
  }
  log('e2b: runtime ready');
}

/**
 * Sanitize a box name for use as the `metadata.name` value. E2B accepts
 * arbitrary strings (probed) but we strip control chars defensively so a name
 * with embedded newlines can't break log parsing or response shapes.
 */
function safeMetadataName(name: string): string {
  return name.replace(/[\u0000-\u001f]/g, '').slice(0, 200);
}

export const e2bBackend: CloudBackend = {
  name: 'e2b',

  // The cloud scaffold's WebProxy binds whatever port we expose here, and
  // `agentbox url --kind=web` resolves via `getHost(port)`. 8080 matches the
  // non-privileged convention vercel uses — `getHost` accepts any port, but
  // staying on 8080 keeps the in-box ctl flag (AGENTBOX_WEB_PROXY_PORT)
  // identical across cloud providers.
  webProxyPort: E2B_WEB_PORT,

  async provision(req: CloudProvisionRequest): Promise<CloudHandle> {
    const apiKey = resolveApiKey();
    const log = req.onLog ?? (() => {});
    // Snapshot id wins (Task 2 checkpoint restore); else the E2B base template.
    // Task 1 doesn't accept Docker-style image refs — they'd be meaningless on
    // E2B until `prepare` bakes a custom template.
    const template = req.snapshot ?? E2B_BASE_TEMPLATE;

    // No-retry: Sandbox.create is billable and non-idempotent — a timeout
    // after the request reached the origin could leave a duplicate sandbox we
    // can't reference for cleanup.
    const sb = await withE2bRetry(
      { method: 'provision', retryOnAmbiguous: false, attemptTimeoutMs: 300_000, backoffMs: [] },
      async () =>
        Sandbox.create({
          apiKey,
          template,
          // Friendly name (so prune can see it) + the 'agentbox' marker so
          // `list()` can filter out sandboxes provisioned by other tooling.
          metadata: { agentbox: 'true', 'agentbox.name': safeMetadataName(req.name), name: safeMetadataName(req.name) },
          envs: req.env,
          timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        }),
    );
    log(`e2b: created sandbox ${sb.sandboxId}`);
    try {
      await seedE2bRuntime(sb, log);
    } catch (err) {
      // The sandbox is billable until killed; if fixup blows up, kill it
      // before throwing so we don't leak.
      try {
        await sb.kill();
      } catch {
        // best-effort cleanup
      }
      throw err;
    }
    return { sandboxId: sb.sandboxId };
  },

  async get(sandboxId: string): Promise<CloudHandle | null> {
    const apiKey = resolveApiKey();
    return withE2bRetry({ method: 'get', retryOnAmbiguous: true }, async () => {
      try {
        // Static, NON-resuming — won't wake a paused sandbox just to confirm
        // it exists (per orchestrator review #1: connect would auto-resume).
        await Sandbox.getInfo(sandboxId, { apiKey });
        return { sandboxId };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    });
  },

  async list(): Promise<CloudSandboxSummary[]> {
    const apiKey = resolveApiKey();
    return withE2bRetry({ method: 'list', retryOnAmbiguous: true }, async () => {
      const summaries: CloudSandboxSummary[] = [];
      // Default query returns both running and paused sandboxes. We filter
      // client-side to the ones we created (metadata.agentbox === 'true').
      for (const state of ['running', 'paused'] as const) {
        const paginator = Sandbox.list({ apiKey, query: { state: [state] } });
        while (paginator.hasNext) {
          const page = await paginator.nextItems();
          for (const info of page) {
            if (info.metadata?.['agentbox'] !== 'true') continue;
            const friendly =
              info.metadata?.['agentbox.name'] ?? info.metadata?.['name'];
            const summary: CloudSandboxSummary = { sandboxId: info.sandboxId, state };
            if (friendly) summary.name = friendly;
            const startedAt = info.startedAt;
            if (startedAt instanceof Date) summary.createdAt = startedAt.toISOString();
            summaries.push(summary);
          }
        }
      }
      return summaries;
    });
  },

  // E2B has no separate stop primitive — sandboxes are either running or
  // paused. start is therefore a connect-and-resume (auto-resume inside
  // Sandbox.connect handles a paused box transparently).
  async start(h: CloudHandle): Promise<void> {
    const apiKey = resolveApiKey();
    await withE2bRetry(
      { method: 'start', retryOnAmbiguous: true, attemptTimeoutMs: 120_000 },
      async () => {
        await Sandbox.connect(h.sandboxId, { apiKey });
      },
    );
  },

  // stop ≡ pause on E2B (the pause IS the cold-storage state).
  async stop(h: CloudHandle): Promise<void> {
    await this.pause(h);
  },

  async pause(h: CloudHandle): Promise<void> {
    const apiKey = resolveApiKey();
    await withE2bRetry(
      { method: 'pause', retryOnAmbiguous: true, attemptTimeoutMs: 120_000 },
      async () => {
        await Sandbox.pause(h.sandboxId, { apiKey });
      },
    );
  },

  async resume(h: CloudHandle): Promise<void> {
    await this.start(h);
  },

  async destroy(h: CloudHandle): Promise<void> {
    const apiKey = resolveApiKey();
    await withE2bRetry(
      { method: 'destroy', retryOnAmbiguous: true, attemptTimeoutMs: 120_000 },
      async () => {
        try {
          await Sandbox.kill(h.sandboxId, { apiKey });
        } catch (err) {
          if (isNotFound(err)) return; // idempotent
          throw err;
        }
      },
    );
  },

  async state(h: CloudHandle): Promise<CloudState> {
    const apiKey = resolveApiKey();
    return withE2bRetry({ method: 'state', retryOnAmbiguous: true }, async () => {
      try {
        const info: SandboxInfo = await Sandbox.getInfo(h.sandboxId, { apiKey });
        return mapState(info.state);
      } catch (err) {
        if (isNotFound(err)) return 'missing';
        throw err;
      }
    });
  },

  async exec(h: CloudHandle, cmd: string, opts?: CloudExecOptions): Promise<CloudExecResult> {
    const apiKey = resolveApiKey();
    // Default per-attempt cap is 5 min — covers the cloud scaffold's
    // workspace-seed/carry extracts (tar of thousands of files, chown -R).
    // Callers can shorten with opts.attemptTimeoutMs for snappier probes.
    const timeoutMs = opts?.attemptTimeoutMs ?? 300_000;
    return withE2bRetry(
      {
        method: 'exec',
        retryOnAmbiguous: opts?.noRetry ? false : true,
        attemptTimeoutMs: timeoutMs,
        backoffMs: opts?.noRetry ? [] : undefined,
      },
      async () => {
        // Connect for the live handle — auto-resumes a paused box, which is
        // the correct semantics for exec (caller wants the command to run).
        const sb = await Sandbox.connect(h.sandboxId, { apiKey });
        // E2B's `commands.run` accepts only 'root' | 'user' | 'vscode'…; any
        // unix username we create in the fixup is valid. Pass through.
        const user = (opts?.user ?? BOX_USER) as 'root' | 'user';
        try {
          const r = await sb.commands.run(cmd, {
            ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
            ...(opts?.env !== undefined ? { envs: opts.env } : {}),
            user,
            timeoutMs,
          });
          return { exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
        } catch (err) {
          // commands.run throws on non-zero exit; the CommandResult fields
          // (exitCode/stdout/stderr) hang off the error. Map back into our
          // CloudExecResult so callers see exit=1, not a thrown exception
          // (vercel/daytona/hetzner exec contract returns the result).
          if (err instanceof Error && err.name === 'CommandExitError') {
            const ce = err as unknown as {
              exitCode: number;
              stdout: string;
              stderr: string;
            };
            return { exitCode: ce.exitCode, stdout: ce.stdout ?? '', stderr: ce.stderr ?? '' };
          }
          throw err;
        }
      },
    );
  },

  async uploadFile(h: CloudHandle, localPath: string, remotePath: string): Promise<void> {
    const apiKey = resolveApiKey();
    await withE2bRetry(
      { method: 'uploadFile', retryOnAmbiguous: true, attemptTimeoutMs: 300_000 },
      async () => {
        const data = await readFile(localPath);
        const sb = await Sandbox.connect(h.sandboxId, { apiKey });
        await sb.files.write([{ path: remotePath, data: bufferToArrayBuffer(data) }]);
        // files.write writes as the default user; chown to vscode so reads
        // from the scaffold's `sudo -u vscode …` exec calls succeed. Best-
        // effort — a chown failure on a world-readable file is harmless.
        try {
          await sb.commands.run(`sudo -n chown ${BOX_OWNER} ${shq(remotePath)}`, {
            user: 'root',
            timeoutMs: 10_000,
          });
        } catch {
          // ignore — file is at least present and readable
        }
      },
    );
  },

  async downloadFile(h: CloudHandle, remotePath: string, localPath: string): Promise<void> {
    const apiKey = resolveApiKey();
    await withE2bRetry(
      { method: 'downloadFile', retryOnAmbiguous: true, attemptTimeoutMs: 300_000 },
      async () => {
        const sb = await Sandbox.connect(h.sandboxId, { apiKey });
        const bytes = await sb.files.read(remotePath, { format: 'bytes' });
        const { writeFile } = await import('node:fs/promises');
        await writeFile(localPath, Buffer.from(bytes));
      },
    );
  },

  async listFiles(h: CloudHandle, remoteDir: string): Promise<CloudFileEntry[]> {
    const apiKey = resolveApiKey();
    return withE2bRetry({ method: 'listFiles', retryOnAmbiguous: true }, async () => {
      const sb = await Sandbox.connect(h.sandboxId, { apiKey });
      const entries = await sb.files.list(remoteDir);
      return entries.map((e) => ({ name: e.name, isDir: e.type === 'dir' }));
    });
  },

  async previewUrl(h: CloudHandle, port: number): Promise<CloudPreviewUrl> {
    const apiKey = resolveApiKey();
    return withE2bRetry({ method: 'previewUrl', retryOnAmbiguous: true }, async () => {
      const sb = await Sandbox.connect(h.sandboxId, { apiKey });
      // getHost returns a `{port}-{sandboxId}.{domain}` hostname. By default
      // (allowPublicTraffic=true) the URL is reachable with no token; we
      // don't wire `trafficAccessToken` for Task 1.
      return { url: `https://${sb.getHost(port)}`, token: undefined };
    });
  },

  // Fewer params than the interface's (h, port, expiresInSeconds) is fine —
  // E2B preview URLs are already public + browser-usable; no per-URL TTL.
  async signedPreviewUrl(h: CloudHandle, port: number): Promise<CloudPreviewUrl> {
    return this.previewUrl(h, port);
  },
};
