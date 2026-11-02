import { useState, useEffect } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { useLocation, useParams, Link } from 'react-router-dom';
import { z } from 'zod';
import { useSession } from '../auth/session';
import { configuration } from '../config';
import { Button } from '../components/ui/button';

const previewSchema = z.object({
  clientName: z.string(), clientId: z.string(), redirectUri: z.string().url(),
  choices: z.array(z.object({ agentId: z.string(), agentName: z.string(),
    projectId: z.string().uuid(), projectName: z.string() })),
});
const connectionsSchema = z.array(z.object({ id: z.string().uuid(), agentName: z.string(),
  projectName: z.string(), clientName: z.string().nullable(), expiresAt: z.string() }));

// These requests carry the human's Auth0 access token. OAuth credentials are
// returned directly to the IDE through its callback and token exchange.
function useOAuthRequest() {
  const { getAccessTokenSilently } = useAuth0();
  return async (path: string, method = 'GET', body?: unknown) => {
    if (!configuration.config) throw new Error('Missing API configuration');
    const token = await getAccessTokenSilently();
    const response = await fetch(`${configuration.config.apiBaseUrl}/api/mcp/oauth/${path}`, {
      method, cache: 'no-store', credentials: 'omit', redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(
      response.status === 404 ? 'OAuth is unavailable or this request expired. Start a new connection from your IDE.'
        : `Could not complete the request (${response.status}). Start a new connection if necessary.`,
    );
    return response.status === 204 ? null : response.json();
  };
}

export function McpOAuthPage() {
  const { ticket } = useParams();
  const location = useLocation();
  const { user, signIn, error: sessionError } = useSession();
  const request = useOAuthRequest();
  const [preview, setPreview] = useState<z.infer<typeof previewSchema> | null>(null);
  const [choice, setChoice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!user || !ticket) return;
    let cancelled = false;
    request('preview', 'POST', { ticket }).then((data) => {
      if (!cancelled) setPreview(previewSchema.parse(data));
    }).catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
    // Re-fetch only for a different request or human, not every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket, user?.id]);
  async function decide(allow: boolean) {
    if (busy) return;
    const selected = preview?.choices.find((c) => `${c.projectId}:${c.agentId}` === choice);
    setBusy(true); setError('');
    try {
      const result = z.object({ redirectUrl: z.string().url() }).parse(await request('consent', 'POST', {
        ticket, allow, ...(allow && selected ? { projectId: selected.projectId, agentId: selected.agentId } : {}),
      }));
      // Only the backend's stored, registered callback may receive the code.
      window.location.assign(result.redirectUrl);
    } catch (e) { setError(e instanceof Error ? e.message : 'Authorization failed'); setBusy(false); }
  }
  return <main className="p-8 max-w-2xl mx-auto space-y-6">
    <h1 className="text-3xl font-bold">Connect your agent to Tandem</h1>
    {!user ? <>
      <p>Sign in to choose which agent and project this connection can access.</p>
      <Button onClick={() => void signIn(location.pathname)}>Sign in with Auth0</Button>
    </> : preview ? <>
      <p><strong>{preview.clientName}</strong> is requesting agent access. Client names are supplied by the requesting application; approve only a connection you started.</p>
      <p className="break-all">Callback: {preview.redirectUri}</p>
      <p className="break-all text-sm">Client ID: {preview.clientId}</p>
      <label className="block">Agent and project
        <select className="block w-full border rounded p-3 mt-2" value={choice} onChange={(e) => setChoice(e.target.value)}>
          <option value="">Choose an agent…</option>
          {preview.choices.map((c) => <option key={`${c.projectId}:${c.agentId}`} value={`${c.projectId}:${c.agentId}`}>
            {c.projectName} — {c.agentName}
          </option>)}
        </select>
      </label>
      {!preview.choices.length && <p>Add an agent in your project's Agents page first, then start a new connection. You must own the agent and project.</p>}
      <p>This allows the client to use available agent tools for the selected project. It does not grant human approval permissions. The connection expires after 30 days and can be disconnected earlier.</p>
      <div className="flex gap-3">
        <Button disabled={busy || !choice} onClick={() => void decide(true)}>Allow connection</Button>
        <Button variant="outline" disabled={busy} onClick={() => void decide(false)}>Deny</Button>
      </div>
    </> : !error && <p role="status">Loading authorization request…</p>}
    {(error || sessionError) && <p role="alert">{error || sessionError?.message}</p>}
    <Link to="/">Return to dashboard</Link>
  </main>;
}

export function McpConnectionsPage() {
  const { user, signIn, error: sessionError } = useSession();
  const request = useOAuthRequest();
  const [connections, setConnections] = useState<z.infer<typeof connectionsSchema>>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function load() { setConnections(connectionsSchema.parse(await request('connections'))); }
  useEffect(() => {
    if (user) void load().catch((e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);
  async function disconnect(id: string) {
    setBusy(true); setError('');
    try { await request(`connections/${id}`, 'DELETE'); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Disconnect failed'); }
    finally { setBusy(false); }
  }
  return <main className="p-8 max-w-2xl mx-auto space-y-6">
    <h1 className="text-3xl font-bold">Connected MCP clients</h1>
    {!user ? <Button onClick={() => void signIn('/mcp/connections')}>Sign in</Button> : <>
      {connections.map((c) => <section key={c.id} className="border rounded p-4 space-y-3">
        <p>{c.clientName || 'MCP client'} — {c.projectName} / {c.agentName}</p>
        <p>Expires {new Date(c.expiresAt).toLocaleString()}</p>
        <Button disabled={busy} onClick={() => void disconnect(c.id)}>Disconnect</Button>
      </section>)}
      {!connections.length && !error && <p>No active OAuth connections.</p>}
    </>}
    {(error || sessionError) && <p role="alert">{error || sessionError?.message}</p>}
    <Link to="/">Return to dashboard</Link>
  </main>;
}
