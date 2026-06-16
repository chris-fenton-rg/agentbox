# @agentbox/control-plane

The AgentBox **hosted control plane** — the `@agentbox/relay` core wrapped as a
Next.js app. The **same code** deploys to Vercel (managed) or self-hosts on a
VPS (Postgres + `next start`). It holds the centralized concerns so boxes don't
have to:

- **git credentials** — a GitHub App; it leases 1-hour, single-repo installation
  tokens to boxes on demand (`git.lease-token`). The plane never holds a PAT and
  never a box's repo.
- **permission state** — pending approvals live in Postgres; boxes poll
  `/rpc/status/:id`, approvers answer via `/admin/prompts/answer` (or the
  dashboard). No long-lived connections.
- **registry / events / status** — one cross-machine view of every box.

It is **stateless per request** (all state in Postgres) and does **no host
execution**: host-local actions (`cp`, `download`, `checkpoint`, docker-style
`git push`) are rejected — cloud boxes push via leasing. The long-lived laptop
relay (`agentbox-relay serve`) is unchanged and shares the same core.

## Endpoints

Box (per-box bearer): `POST /events`, `POST /rpc` (`git.lease-token`,
`browser.open`), `GET /rpc/status/:promptId`.
Admin (the `AGENTBOX_RELAY_ADMIN_TOKEN` bearer, never loopback):
`POST /admin/register-box`, `POST /admin/forget-box`, `GET /admin/box-status`,
`GET /admin/events`, `GET /admin/registry`, `GET /admin/prompts`,
`POST /admin/prompts/answer`. `GET /healthz` is open.

## Configuration

See [`.env.example`](./.env.example). Required: `POSTGRES_URL`,
`AGENTBOX_RELAY_ADMIN_TOKEN`. Optional (enables leasing): `GITHUB_APP_ID` +
`GITHUB_APP_PRIVATE_KEY` (raw or base64 PEM). Tables are created automatically on
first request (`PostgresStore.migrate`).

## Deploy

The turnkey path is `agentbox control-plane setup` (creates the GitHub App, then
`--deploy vercel|hetzner`, then points the CLI at it). The recipes below are the
manual equivalents / self-host path.

### Self-host (docker-compose)

```bash
export AGENTBOX_RELAY_ADMIN_TOKEN=$(openssl rand -hex 32)
docker compose up --build      # Postgres + the app on :8787
curl localhost:8787/healthz
```

### Vercel

`agentbox control-plane setup --deploy vercel` is the supported path: it creates a
**Git-connected** project (repo `--repo`, default `madarco/agentbox`; Root Directory
`apps/control-plane`), auto-provisions Neon, sets the App env, and builds `--ref` (default
`main`) **from GitHub** — no local upload, so it works from a global npm install. Vercel
only connects a repo whose owner has the Vercel GitHub App, so deploy a repo you own or a
fork (`--repo <you>/agentbox`). Manual equivalent (dashboard or CLI): create the project
with Root Directory `apps/control-plane`, attach Neon, set `GITHUB_APP_ID` /
`GITHUB_APP_PRIVATE_KEY` / `AGENTBOX_RELAY_ADMIN_TOKEN`, then deploy.

Then point boxes/CLI at it: `agentbox control-plane set-url https://<deployment>`.

## GitHub App setup (for leasing)

Create a GitHub App, grant **Repository permissions → Contents: Read & write**
and **Pull requests: Read & write**, install it on the repos your boxes work in,
download a private key, and set `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`.
Installation tokens are repo-scoped and expire in 1 hour; the plane re-mints as
needed and never persists them.
