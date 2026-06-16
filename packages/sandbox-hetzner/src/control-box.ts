/**
 * Hetzner control-box provisioning.
 *
 * A *control box* is an always-on Hetzner VPS that runs the AgentBox relay in
 * `--control-box` mode, so boxes (and the laptop CLI) keep pushing / opening
 * PRs / creating boxes when the laptop is off. Unlike per-box VPSes it never
 * sleeps and is reachable over the public internet, so:
 *   - The relay binds 127.0.0.1:8787 and **Caddy** terminates TLS on :443,
 *     auto-getting a Let's Encrypt cert for `https://<ip>.sslip.io` (no domain
 *     needed). That URL becomes `relay.controlBoxUrl`.
 *   - The firewall opens 443 + 80 (ACME) to the world and 22 to the host's
 *     egress IP only.
 *   - `/admin` + `/remote` are gated by an admin bearer (the relay's
 *     `--control-box` mode), not loopback.
 *
 * Secrets on the box live in `/etc/agentbox/relay.env` (0600): the admin token
 * and the GitHub PAT (set later via `set-token`). We deliberately do NOT ship
 * cloud-provider tokens or per-box SSH keys here — the box→control-box git path
 * sends bundles up rather than having the control box reach back into boxes.
 *
 * Provisioning mirrors `prepareHetzner`: mint key → firewall → createServer
 * (stock ubuntu-24.04, root login) → waitForSsh → scp relay bin + env + setup
 * script → run setup (installs node + caddy, writes units, starts services).
 */

import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHetznerClient, type HetznerClient, type HetznerFirewallRule } from './client.js';
import { detectEgressIp } from './egress-ip.js';
import { normalizeSourceCidr } from './firewall.js';
import { generatePrepareCloudInit } from './cloud-init.js';
import { mintSshKey } from './ssh-key.js';
import { scpUpload, sshExec, waitForSsh, type SshTargetArgs } from './ssh-cli.js';

const STATE_DIR = join(homedir(), '.agentbox');
const CONTROL_BOX_DIR = join(STATE_DIR, 'control-box');
const STATE_FILE = join(STATE_DIR, 'control-box.json');
const SSH_DIR = join(CONTROL_BOX_DIR, 'ssh');

const SERVER_TYPE_DEFAULT = 'cx23'; // smallest current x86 shared vCPU; ~EUR6.5/mo (cx22 retired).
const LOCATION_DEFAULT = 'nbg1';
const RELAY_PORT = 8787;
const SSH_DEADLINE_MS = 180_000;
const SETUP_TIMEOUT_MS = 600_000; // node + caddy apt installs can be a few min.

export interface ControlBoxState {
  provider: 'hetzner';
  serverId: number;
  firewallId: number;
  ip: string;
  url: string;
  /** Admin bearer for /admin + /remote on the control-box relay. Secret. */
  adminToken: string;
  sshDir: string;
  serverType: string;
  location: string;
  createdAt: string;
}

export function readControlBoxState(): ControlBoxState | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as ControlBoxState;
  } catch {
    return null;
  }
}

function writeControlBoxState(state: ControlBoxState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

export interface ProvisionControlBoxOptions {
  /** Absolute path to the freshly-built relay bin (packages/relay/dist/bin.cjs). */
  relayBinPath: string;
  serverType?: string;
  location?: string;
  /** Override the SSH-source CIDR (default: auto-detected host egress IP/32). */
  sshSource?: string;
  onLog?: (line: string) => void;
}

export interface ProvisionResult {
  state: ControlBoxState;
}

function controlBoxFirewallRules(sshSource: string): HetznerFirewallRule[] {
  return [
    { direction: 'in', protocol: 'tcp', port: '443', source_ips: ['0.0.0.0/0', '::/0'], description: 'control-box relay (https)' },
    { direction: 'in', protocol: 'tcp', port: '80', source_ips: ['0.0.0.0/0', '::/0'], description: 'ACME http-01' },
    { direction: 'in', protocol: 'tcp', port: '22', source_ips: [sshSource], description: 'management ssh (host egress only)' },
  ];
}

/**
 * Provision a fresh Hetzner control box. Idempotency is the caller's job —
 * this always creates a new server + firewall. On any failure after the server
 * or firewall is created, both are torn down before throwing.
 */
export async function provisionControlBox(
  opts: ProvisionControlBoxOptions,
): Promise<ProvisionResult> {
  const log = opts.onLog ?? (() => {});
  const client: HetznerClient = makeHetznerClient();
  const serverType = opts.serverType ?? SERVER_TYPE_DEFAULT;
  const location = opts.location ?? LOCATION_DEFAULT;

  const adminToken = randomBytes(32).toString('hex');
  const stamp = Date.now().toString(36);

  // 1. Fresh ssh key (kept — needed for set-token / management later).
  await rm(SSH_DIR, { recursive: true, force: true });
  await mkdir(SSH_DIR, { recursive: true, mode: 0o700 });
  const key = await mintSshKey(SSH_DIR, `agentbox-control-box-${stamp}`);

  // 2. SSH source = host egress IP (management only).
  const sshSource = opts.sshSource
    ? normalizeSourceCidr(opts.sshSource)
    : `${await detectEgressIp({ onLog: log })}/32`;
  log(`management ssh locked to ${sshSource}`);

  let firewallId: number | null = null;
  let serverId: number | null = null;
  try {
    // 3. Firewall: 443+80 world, 22 host-only.
    const firewall = await client.createFirewall({
      name: `agentbox-control-box-${stamp}`,
      rules: controlBoxFirewallRules(sshSource),
      labels: { 'agentbox.managed': 'true', 'agentbox.role': 'control-box' },
    });
    firewallId = firewall.id;

    // 4. Stock ubuntu-24.04, root login (setup installs node + caddy + relay).
    const cloudInit = generatePrepareCloudInit({ sshPubkey: key.publicKey });
    log(`creating control-box VPS (${serverType} / ${location})`);
    const created = await client.createServer({
      name: `agentbox-control-box-${stamp}`,
      server_type: serverType,
      image: 'ubuntu-24.04',
      location,
      user_data: cloudInit,
      firewalls: [{ firewall: firewall.id }],
      labels: { 'agentbox.managed': 'true', 'agentbox.role': 'control-box' },
      start_after_create: true,
    });
    serverId = created.server.id;
    const ip = created.server.public_net.ipv4?.ip;
    if (!ip) throw new Error('hetzner: control-box VPS came up without an IPv4 address');
    const url = `https://${ip}.sslip.io`;

    // 5. Wait for sshd.
    const sshTarget: SshTargetArgs = {
      host: ip,
      user: 'root',
      identity: key.privatePath,
      knownHosts: join(key.dir, 'known_hosts'),
    };
    log(`waiting for ssh on ${ip}`);
    if (!(await waitForSsh(sshTarget, SSH_DEADLINE_MS))) {
      throw new Error(`hetzner: ssh on ${ip} did not come up within ${SSH_DEADLINE_MS / 1000}s`);
    }

    // 6. Stage relay.env + setup.sh locally (secrets via files, never argv).
    const stage = join(tmpdir(), `agentbox-cb-${stamp}`);
    await mkdir(stage, { recursive: true });
    const envLocal = join(stage, 'relay.env');
    await writeFile(
      envLocal,
      [
        '# AgentBox control-box relay env (0600). Sourced by the systemd unit.',
        `AGENTBOX_RELAY_ADMIN_TOKEN=${adminToken}`,
        'GH_TOKEN=', // set later via `agentbox control-box set-token`
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    const setupLocal = join(stage, 'cb-setup.sh');
    await writeFile(setupLocal, controlBoxSetupScript({ ip, relayPort: RELAY_PORT }), { mode: 0o755 });

    try {
      // 7. scp relay bin + env + setup script.
      log('uploading relay bin + setup');
      await scpUpload(sshTarget, opts.relayBinPath, '/tmp/agentbox-relay.cjs');
      await scpUpload(sshTarget, envLocal, '/tmp/relay.env');
      await scpUpload(sshTarget, setupLocal, '/tmp/cb-setup.sh');

      // 8. Run setup (installs node + caddy, writes units, starts services).
      log('running control-box setup (installs node + caddy; ~2-4 min)');
      const setup = await sshExec(sshTarget, 'bash /tmp/cb-setup.sh 2>&1', {
        timeoutMs: SETUP_TIMEOUT_MS,
        onLine: (line) => log(`[setup] ${line}`),
      });
      if (setup.exitCode !== 0) {
        throw new Error(`control-box setup failed (exit ${setup.exitCode}): ${setup.stderr.slice(-400)}`);
      }
    } finally {
      await rm(stage, { recursive: true, force: true });
    }

    // 9. Wait for the public HTTPS relay (Caddy needs to fetch the cert).
    log(`waiting for ${url}/healthz (Caddy TLS provisioning)`);
    await waitForHealthz(url, 120_000, log);

    const state: ControlBoxState = {
      provider: 'hetzner',
      serverId,
      firewallId,
      ip,
      url,
      adminToken,
      sshDir: SSH_DIR,
      serverType,
      location,
      createdAt: new Date().toISOString(),
    };
    writeControlBoxState(state);
    return { state };
  } catch (err) {
    // Tear down partial infra so a failed provision doesn't leave a billable
    // VPS + firewall behind.
    if (serverId !== null) await client.deleteServer(serverId).catch(() => {});
    if (firewallId !== null) await client.deleteFirewall(firewallId).catch(() => {});
    throw err;
  }
}

/** Tear down the control box (server + firewall) and clear local state. */
export async function destroyControlBox(opts: { onLog?: (line: string) => void } = {}): Promise<boolean> {
  const log = opts.onLog ?? (() => {});
  const state = readControlBoxState();
  if (!state) return false;
  const client = makeHetznerClient();
  log(`deleting control-box server ${state.serverId}`);
  await client.deleteServer(state.serverId).catch((e: unknown) => log(`server delete: ${String(e)}`));
  // The firewall can only be deleted once it's detached; deleting the server
  // detaches it. Retry briefly.
  for (let i = 0; i < 5; i++) {
    try {
      await client.deleteFirewall(state.firewallId);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  try {
    await rm(STATE_FILE, { force: true });
    await rm(SSH_DIR, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  return true;
}

/** Set/refresh the GitHub PAT on the control box (writes relay.env, restarts relay). */
export async function setControlBoxToken(
  pat: string,
  opts: { onLog?: (line: string) => void } = {},
): Promise<void> {
  const log = opts.onLog ?? (() => {});
  const state = readControlBoxState();
  if (!state) throw new Error('no control box configured — run `agentbox control-box create` first');
  const sshTarget: SshTargetArgs = {
    host: state.ip,
    user: 'root',
    identity: join(state.sshDir, 'id_ed25519'),
    knownHosts: join(state.sshDir, 'known_hosts'),
  };
  // Rewrite only the GH_TOKEN line, then restart the relay so it re-reads env.
  // The PAT travels in the file content piped over stdin-free scp, never argv.
  const stage = join(tmpdir(), `agentbox-cb-tok-${Date.now().toString(36)}`);
  await mkdir(stage, { recursive: true });
  const tokFile = join(stage, 'gh_token');
  try {
    await writeFile(tokFile, pat.trim() + '\n', { mode: 0o600 });
    await scpUpload(sshTarget, tokFile, '/tmp/gh_token');
    const r = await sshExec(
      sshTarget,
      [
        'set -e',
        'tok=$(cat /tmp/gh_token); rm -f /tmp/gh_token',
        // Replace (or append) the GH_TOKEN line in /etc/agentbox/relay.env.
        "grep -v '^GH_TOKEN=' /etc/agentbox/relay.env > /etc/agentbox/relay.env.new || true",
        'printf "GH_TOKEN=%s\\n" "$tok" >> /etc/agentbox/relay.env.new',
        'mv /etc/agentbox/relay.env.new /etc/agentbox/relay.env',
        'chmod 600 /etc/agentbox/relay.env',
        'systemctl restart agentbox-relay',
      ].join('\n'),
      { timeoutMs: 30_000, onLine: (l) => log(`[set-token] ${l}`) },
    );
    if (r.exitCode !== 0) throw new Error(`set-token failed (exit ${r.exitCode}): ${r.stderr.slice(-300)}`);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function waitForHealthz(url: string, deadlineMs: number, log: (l: string) => void): Promise<void> {
  const stop = Date.now() + deadlineMs;
  let lastErr = '';
  while (Date.now() < stop) {
    try {
      const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) return;
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.name : String(e);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  log(`healthz not ready after ${deadlineMs / 1000}s (last: ${lastErr}) — the VPS may still be fetching its TLS cert`);
  throw new Error(`control-box ${url}/healthz did not become ready (last: ${lastErr})`);
}

/**
 * The setup script run on the control-box VPS as root. Installs node + caddy,
 * writes the Caddyfile (TLS reverse-proxy to the local relay), a systemd unit
 * for the relay, and starts both. `ip` is the public IPv4 (for the sslip.io
 * cert host); `relayPort` is the loopback port the relay binds.
 */
function controlBoxSetupScript(args: { ip: string; relayPort: number }): string {
  const host = `${args.ip}.sslip.io`;
  return `#!/usr/bin/env bash
set -euo pipefail

echo ">>> install node + caddy"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl debian-keyring debian-archive-keyring apt-transport-https ca-certificates gnupg

# Node 22 (NodeSource)
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs
fi
node --version

# Caddy (official apt repo)
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

echo ">>> install relay bin + env"
install -d -m 755 /opt/agentbox
install -m 755 /tmp/agentbox-relay.cjs /opt/agentbox/relay.cjs && rm -f /tmp/agentbox-relay.cjs
install -d -m 755 /etc/agentbox
install -m 600 /tmp/relay.env /etc/agentbox/relay.env && rm -f /tmp/relay.env

echo ">>> write Caddyfile"
cat > /etc/caddy/Caddyfile <<EOF
${host} {
\treverse_proxy 127.0.0.1:${String(args.relayPort)}
}
EOF

echo ">>> write systemd unit"
cat > /etc/systemd/system/agentbox-relay.service <<EOF
[Unit]
Description=AgentBox control-box relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/agentbox/relay.env
ExecStart=/usr/bin/node /opt/agentbox/relay.cjs serve --port ${String(args.relayPort)} --host 127.0.0.1 --control-box
Restart=always
RestartSec=2
User=root

[Install]
WantedBy=multi-user.target
EOF

echo ">>> start services"
systemctl daemon-reload
systemctl enable --now caddy >/dev/null 2>&1 || systemctl restart caddy
systemctl restart caddy
systemctl enable --now agentbox-relay
sleep 2
systemctl is-active agentbox-relay
echo ">>> setup complete for ${host}"
`;
}
