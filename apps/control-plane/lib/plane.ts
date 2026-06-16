import {
  GitHubAppLeaser,
  handleRelayRequest,
  loadGitHubAppConfig,
  PostgresStore,
  type ControlPlaneDeps,
} from '@agentbox/relay/control-plane';

/**
 * Build the control-plane deps once per server instance. On serverless this is
 * per warm instance (cheap to rebuild on a cold start); the Postgres pool is
 * created lazily inside PostgresStore on first query.
 */
let depsPromise: Promise<ControlPlaneDeps> | null = null;

function buildDeps(): Promise<ControlPlaneDeps> {
  const url = process.env.POSTGRES_URL ?? process.env.RELAY_STORE_URL;
  if (!url) throw new Error('control-plane: POSTGRES_URL (or RELAY_STORE_URL) is required');
  const adminToken = process.env.AGENTBOX_RELAY_ADMIN_TOKEN ?? '';
  if (adminToken.length === 0) {
    throw new Error('control-plane: AGENTBOX_RELAY_ADMIN_TOKEN is required (admin endpoints fail closed)');
  }
  const store = new PostgresStore({ connectionString: url });
  const appCfg = loadGitHubAppConfig();
  const leaser = appCfg ? new GitHubAppLeaser(appCfg) : null;
  return store.migrate().then(() => ({
    store,
    leaser,
    adminToken,
    log: (line: string) => console.log(`[control-plane] ${line}`),
  }));
}

function getDeps(): Promise<ControlPlaneDeps> {
  if (!depsPromise) {
    depsPromise = buildDeps().catch((err: unknown) => {
      // Reset so the next request retries the build (e.g. transient DB outage)
      // instead of caching a rejected promise forever.
      depsPromise = null;
      throw err;
    });
  }
  return depsPromise;
}

function bearerOf(request: Request): string {
  const raw = request.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1]!.trim() : '';
}

/** Adapt a Web Request → the relay core → a Web Response. */
export async function dispatch(request: Request): Promise<Response> {
  let deps: ControlPlaneDeps;
  try {
    deps = await getDeps();
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'control-plane misconfigured' },
      { status: 503 },
    );
  }
  const url = new URL(request.url);
  const bodyText =
    request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
  const res = await handleRelayRequest(
    {
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      bearer: bearerOf(request),
      bodyText,
    },
    deps,
  );
  if (res.body === undefined || res.body === null) {
    return new Response(null, { status: res.status });
  }
  return Response.json(res.body, { status: res.status });
}
