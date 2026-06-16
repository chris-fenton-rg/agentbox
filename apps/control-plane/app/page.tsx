'use client';

// Minimal admin dashboard for the hosted control plane. It is a pure client
// view: it reuses the existing admin-bearer auth (the token is kept in
// sessionStorage and sent as the Bearer on every /admin/* fetch) rather than
// introducing a server-side session. The server never sees the token except as
// a per-request bearer the same handlers already validate.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

interface Box {
  boxId: string;
  name: string;
  kind?: string;
  registeredAt?: string;
  projectIndex?: number;
  originUrl?: string;
}
interface PromptContext {
  command?: string;
  cwd?: string;
  argv?: string[];
}
interface Prompt {
  id: string;
  kind: string;
  message: string;
  detail?: string;
  context?: PromptContext;
}
interface Event {
  id: number;
  boxId: string;
  type: string;
  receivedAt: string;
  payload?: unknown;
}
interface Health {
  ok: boolean;
  boxes: number;
  events: number;
}
interface Snapshot {
  health: Health | null;
  boxes: Box[];
  prompts: Array<Prompt & { boxId: string; boxName: string }>;
  events: Event[];
}

const REFRESH_MS = 4000;

export default function Dashboard() {
  const [token, setToken] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string>('');
  const busy = useRef(false);

  useEffect(() => {
    const t = sessionStorage.getItem('agentbox-admin-token');
    if (t) setToken(t);
  }, []);

  const authed = useCallback(
    (path: string, init?: RequestInit) =>
      fetch(path, { ...init, headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token ?? ''}` } }),
    [token],
  );

  const refresh = useCallback(async () => {
    if (!token || busy.current) return;
    busy.current = true;
    try {
      const health = (await (await fetch('/healthz')).json()) as Health;
      const regRes = await authed('/admin/registry');
      if (regRes.status === 401) {
        setError('Invalid admin token.');
        setToken(null);
        sessionStorage.removeItem('agentbox-admin-token');
        return;
      }
      const boxes = ((await regRes.json()) as { boxes: Box[] }).boxes ?? [];
      // Pending prompts are per-box; fan out across the registry.
      const promptLists = await Promise.all(
        boxes.map(async (b) => {
          const r = await authed(`/admin/prompts?boxId=${encodeURIComponent(b.boxId)}`);
          if (!r.ok) return [];
          const ps = ((await r.json()) as { prompts: Prompt[] }).prompts ?? [];
          return ps.map((p) => ({ ...p, boxId: b.boxId, boxName: b.name }));
        }),
      );
      const events = ((await (await authed('/admin/events')).json()) as { events: Event[] }).events ?? [];
      setSnap({ health, boxes, prompts: promptLists.flat(), events: events.slice(-50).reverse() });
      setError(null);
      setUpdatedAt(new Date().toLocaleTimeString());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busy.current = false;
    }
  }, [authed, token]);

  useEffect(() => {
    if (!token) return;
    void refresh();
    const h = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(h);
  }, [token, refresh]);

  const answer = useCallback(
    async (id: string, ans: 'y' | 'n') => {
      await authed('/admin/prompts/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, answer: ans }),
      });
      void refresh();
    },
    [authed, refresh],
  );

  if (!token) {
    return (
      <main style={{ maxWidth: 420, margin: '12vh auto', padding: 24 }}>
        <h1 style={{ fontSize: 20, marginBottom: 4 }}>AgentBox control plane</h1>
        <p style={{ color: '#9aa0a6', marginTop: 0 }}>Enter the admin token to view boxes, approvals, and events.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!input) return;
            sessionStorage.setItem('agentbox-admin-token', input);
            setToken(input);
            setInput('');
          }}
        >
          <input
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="AGENTBOX_RELAY_ADMIN_TOKEN"
            autoFocus
            style={inputStyle}
          />
          <button type="submit" style={{ ...btnStyle, marginTop: 10, width: '100%' }}>
            Open dashboard
          </button>
        </form>
        {error && <p style={{ color: '#f28b82' }}>{error}</p>}
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 24px 64px' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>AgentBox control plane</h1>
        <div style={{ color: '#9aa0a6', fontSize: 12 }}>
          {snap?.health ? `${snap.health.boxes} box(es), ${snap.health.events} event(s)` : '…'}
          {updatedAt && ` · updated ${updatedAt}`}
          <button
            onClick={() => {
              sessionStorage.removeItem('agentbox-admin-token');
              setToken(null);
              setSnap(null);
            }}
            style={{ ...btnStyle, marginLeft: 12, padding: '2px 8px' }}
          >
            Sign out
          </button>
        </div>
      </header>
      {error && <p style={{ color: '#f28b82' }}>{error}</p>}

      <Section title={`Pending approvals (${snap?.prompts.length ?? 0})`}>
        {snap && snap.prompts.length === 0 && <Empty>No pending approvals.</Empty>}
        {snap?.prompts.map((p) => (
          <div key={p.id} style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <strong>{p.message}</strong>
                {p.detail && <div style={{ color: '#9aa0a6' }}>{p.detail}</div>}
                <div style={{ color: '#9aa0a6', fontSize: 12, marginTop: 4 }}>
                  box {p.boxName} · {p.context?.command ?? p.kind}
                  {p.context?.cwd ? ` · ${p.context.cwd}` : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button onClick={() => void answer(p.id, 'y')} style={{ ...btnStyle, borderColor: '#128a4f', color: '#5fd39a' }}>
                  Approve
                </button>
                <button onClick={() => void answer(p.id, 'n')} style={{ ...btnStyle, borderColor: '#8a3a3a', color: '#f28b82' }}>
                  Deny
                </button>
              </div>
            </div>
          </div>
        ))}
      </Section>

      <Section title={`Boxes (${snap?.boxes.length ?? 0})`}>
        {snap && snap.boxes.length === 0 && <Empty>No boxes registered.</Empty>}
        {snap && snap.boxes.length > 0 && (
          <table style={tableStyle}>
            <thead>
              <tr>
                {['name', 'kind', 'origin', 'registered', 'id'].map((h) => (
                  <th key={h} style={thStyle}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {snap.boxes.map((b) => (
                <tr key={b.boxId}>
                  <td style={tdStyle}>{b.name}</td>
                  <td style={tdStyle}>{b.kind ?? '—'}</td>
                  <td style={{ ...tdStyle, color: '#9aa0a6' }}>{b.originUrl ?? '—'}</td>
                  <td style={{ ...tdStyle, color: '#9aa0a6' }}>
                    {b.registeredAt ? new Date(b.registeredAt).toLocaleString() : '—'}
                  </td>
                  <td style={{ ...tdStyle, color: '#9aa0a6', fontFamily: 'ui-monospace, monospace' }}>{b.boxId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Recent events">
        {snap && snap.events.length === 0 && <Empty>No events yet.</Empty>}
        {snap && snap.events.length > 0 && (
          <table style={tableStyle}>
            <thead>
              <tr>
                {['time', 'box', 'type'].map((h) => (
                  <th key={h} style={thStyle}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {snap.events.map((ev) => (
                <tr key={ev.id}>
                  <td style={{ ...tdStyle, color: '#9aa0a6', whiteSpace: 'nowrap' }}>
                    {new Date(ev.receivedAt).toLocaleTimeString()}
                  </td>
                  <td style={{ ...tdStyle, fontFamily: 'ui-monospace, monospace' }}>{ev.boxId}</td>
                  <td style={tdStyle}>{ev.type}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginTop: 28 }}>
      <h2 style={{ fontSize: 14, textTransform: 'uppercase', letterSpacing: 0.5, color: '#9aa0a6' }}>{title}</h2>
      {children}
    </section>
  );
}
function Empty({ children }: { children: ReactNode }) {
  return <p style={{ color: '#6b7178' }}>{children}</p>;
}

const inputStyle: CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  background: '#16181d',
  border: '1px solid #2a2d34',
  borderRadius: 6,
  color: '#e6e6e6',
  boxSizing: 'border-box',
};
const btnStyle: CSSProperties = {
  background: '#16181d',
  border: '1px solid #2a2d34',
  borderRadius: 6,
  color: '#e6e6e6',
  padding: '6px 12px',
  cursor: 'pointer',
};
const cardStyle: CSSProperties = {
  background: '#16181d',
  border: '1px solid #2a2d34',
  borderRadius: 8,
  padding: 12,
  marginBottom: 8,
};
const tableStyle: CSSProperties = { width: '100%', borderCollapse: 'collapse' };
const thStyle: CSSProperties = {
  textAlign: 'left',
  padding: '6px 8px',
  borderBottom: '1px solid #2a2d34',
  color: '#9aa0a6',
  fontWeight: 500,
  fontSize: 12,
};
const tdStyle: CSSProperties = { padding: '6px 8px', borderBottom: '1px solid #1c1f25' };
