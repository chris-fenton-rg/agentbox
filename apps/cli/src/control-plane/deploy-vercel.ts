import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createGitDeployment,
  createGitProject,
  deleteProject,
  getDeployment,
  getProductionAlias,
  getProject,
  patchProjectSettings,
  resolveVercelApiAuth,
  upsertProjectEnv,
  type VercelProjectFull,
} from '@agentbox/sandbox-vercel';

/**
 * Deploy the control plane to Vercel **from GitHub** (no local upload): connect
 * a Git-backed Vercel project to `<repo>` with Root Directory `apps/control-plane`,
 * provision Neon, set the App env, and trigger a production build of `<ref>`.
 * Works without a monorepo checkout (so a globally-installed CLI can deploy),
 * mirroring how the Hetzner path clones the repo on the VPS.
 *
 * Vercel only connects a repo whose OWNER has the Vercel GitHub App installed —
 * it does not clone arbitrary public repos. So the deployer must own `<repo>`
 * (or fork it and pass `--repo <fork>`); we surface that clearly on failure.
 */
export interface VercelDeployOptions {
  /** App env baked into the build: GITHUB_APP_ID / _PRIVATE_KEY / ADMIN_TOKEN. */
  env: Record<string, string>;
  /** `owner/name` GitHub slug to deploy from. */
  repo: string;
  /** Branch / tag / sha to build. */
  ref: string;
  /** Vercel project name (default agentbox-control-plane). */
  project?: string;
  log: (line: string) => void;
}

const PROJECT_DEFAULT = 'agentbox-control-plane';
const ROOT_DIRECTORY = 'apps/control-plane';

function connectedTo(p: VercelProjectFull | null, repo: string): boolean {
  return (
    !!p?.link &&
    p.link.type === 'github' &&
    `${p.link.org ?? ''}/${p.link.repo ?? ''}`.toLowerCase() === repo.toLowerCase()
  );
}

/**
 * Best-effort Neon provisioning via the logged-in `vercel` CLI. Targets the
 * project headlessly via `VERCEL_PROJECT_ID`/`VERCEL_ORG_ID`; runs in a throwaway
 * temp dir because `vercel integration add` drops a `.env.local` in the cwd
 * (which we don't want littering the user's project).
 */
function provisionNeon(teamId: string | undefined, projectId: string, log: (l: string) => void): Promise<void> {
  return new Promise((resolve) => {
    const work = mkdtempSync(join(tmpdir(), 'agentbox-neon-'));
    const env = { ...process.env, VERCEL_PROJECT_ID: projectId, ...(teamId ? { VERCEL_ORG_ID: teamId } : {}) };
    const child = spawn('vercel', ['integration', 'add', 'neon', '--non-interactive'], {
      cwd: work,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onData = (c: Buffer): void => {
      for (const l of c.toString('utf8').split(/\r?\n/)) if (l.trim()) log(`neon: ${l.trim()}`);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const done = (): void => {
      try {
        rmSync(work, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      resolve();
    };
    child.on('error', (e) => {
      log(`neon: could not run \`vercel integration add neon\` (${e.message}) — continuing`);
      done();
    });
    child.on('close', (code) => {
      if (code !== 0) log(`neon: integration add exited ${String(code)} — continuing (it may already be attached)`);
      done();
    });
  });
}

async function pollDeployment(
  token: string,
  teamId: string | undefined,
  id: string,
  log: (l: string) => void,
): Promise<void> {
  const stop = Date.now() + 20 * 60_000;
  let last = '';
  while (Date.now() < stop) {
    const d = await getDeployment(token, teamId, id);
    if (d.readyState !== last) {
      log(`build: ${d.readyState.toLowerCase()}`);
      last = d.readyState;
    }
    if (d.readyState === 'READY') return;
    if (d.readyState === 'ERROR' || d.readyState === 'CANCELED' || d.readyState === 'BLOCKED') {
      throw new Error(
        `Vercel build ${d.readyState.toLowerCase()}${d.errorStep ? ` at ${d.errorStep}` : ''}: ${d.errorMessage ?? 'see the Vercel dashboard'}`,
      );
    }
    await new Promise((r) => setTimeout(r, 6_000));
  }
  throw new Error('timed out waiting for the Vercel build to finish');
}

export async function deployControlPlaneToVercel(opts: VercelDeployOptions): Promise<{ url: string }> {
  const auth = await resolveVercelApiAuth();
  if (!auth) {
    throw new Error('not logged in to Vercel — run `agentbox vercel login` (or set VERCEL_TOKEN)');
  }
  const { token, teamId } = auth;
  const projectName = opts.project ?? PROJECT_DEFAULT;
  const [owner, repoName] = opts.repo.split('/');
  if (!owner || !repoName) throw new Error(`--repo must be "owner/name" (got "${opts.repo}")`);

  // 1. Find-or-create a project connected to <repo> (gitRepository isn't
  //    PATCH-able, so a mis-linked existing project is recreated).
  opts.log(`ensuring Vercel project "${projectName}" is connected to ${opts.repo}…`);
  let project = await getProject(token, teamId, projectName);
  if (project && !connectedTo(project, opts.repo)) {
    opts.log(`project exists but is not connected to ${opts.repo}; recreating…`);
    await deleteProject(token, teamId, project.id);
    project = null;
  }
  if (!project) {
    try {
      project = await createGitProject(token, teamId, {
        name: projectName,
        repo: opts.repo,
        rootDirectory: ROOT_DIRECTORY,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/install the GitHub integration|integration first|github integration/i.test(msg)) {
        throw new Error(
          `Vercel can't connect ${opts.repo}: the Vercel GitHub App must be installed on "${owner}" with access to the repo ` +
            `(https://vercel.com/account/installations), or fork the repo and pass --repo <yourfork>/${repoName}. [${msg}]`,
        );
      }
      throw e;
    }
  } else {
    await patchProjectSettings(token, teamId, project.id, {
      framework: 'nextjs',
      rootDirectory: ROOT_DIRECTORY,
    });
  }

  // 2. Postgres (Neon injects POSTGRES_URL itself — set it before the build).
  opts.log('provisioning Neon Postgres…');
  await provisionNeon(teamId, project.id, opts.log);

  // 3. App env (build-time).
  opts.log('setting environment variables…');
  await upsertProjectEnv(
    token,
    teamId,
    project.id,
    Object.entries(opts.env).map(([key, value]) => ({ key, value })),
  );

  // 4. Build from GitHub.
  opts.log(`triggering a production build of ${opts.repo}@${opts.ref}…`);
  const dep = await createGitDeployment(token, teamId, {
    name: projectName,
    projectId: project.id,
    owner,
    repo: repoName,
    ref: opts.ref,
  });
  await pollDeployment(token, teamId, dep.id, opts.log);

  // 5. Stable production URL.
  const alias = (await getProductionAlias(token, teamId, project.id)) ?? dep.url ?? null;
  if (!alias) throw new Error('build is ready but no production URL was found');
  return { url: alias.startsWith('http') ? alias : `https://${alias}` };
}
