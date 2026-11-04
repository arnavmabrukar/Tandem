import { useState, useEffect } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { useLocation, useParams, Link } from 'react-router-dom';
import { z } from 'zod';
import { useSession } from '../auth/session';
import { configuration } from '../config';
import { Field } from '../components/common';
import { Button } from '../components/ui/button';

const previewSchema = z.object({
  clientName: z.string(), clientId: z.string(), redirectUri: z.string().url(),
  projects: z.array(z.object({ id: z.string().uuid(), name: z.string(), version: z.number().int() })),
  choices: z.array(z.object({ agentId: z.string(), agentName: z.string(),
    projectId: z.string().uuid(), projectName: z.string() })),
});
const connectionsSchema = z.array(z.object({ id: z.string().uuid(), agentName: z.string(),
  projectName: z.string(), clientName: z.string().nullable(), expiresAt: z.string() }));

class OAuthRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

// These requests carry the human's Auth0 access token. OAuth credentials are
// returned directly to the IDE through its callback and token exchange.
function useOAuthRequest() {
  const { getAccessTokenSilently } = useAuth0();
  return async (path: string, method = 'GET', body?: unknown) => {
    if (!configuration.config) throw new Error('Missing API configuration');
    const token = await getAccessTokenSilently();
    const response = await fetch(`${configuration.config.apiBaseUrl}${path.startsWith('/') ? path : `/api/mcp/oauth/${path}`}`, {
      method, cache: 'no-store', credentials: 'omit', redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        ...(body && typeof body === 'object' && 'operationId' in body
          ? { 'Idempotency-Key': String(body.operationId) } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new OAuthRequestError(
      response.status === 404 ? 'OAuth is unavailable or this request expired. Start a new connection from your IDE.'
        : response.status === 409 ? 'The name is taken or the project changed. Check the name and try again.'
          : `Could not complete the request (${response.status}). Start a new connection if necessary.`, response.status,
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
  const [projectId, setProjectId] = useState('');
  const [name, setName] = useState('');
  const [client, setClient] = useState('Codex');
  // Keep registration payload stable across retries after a network interruption.
  const [registration, setRegistration] = useState<{ projectId: string; body: object } | null>(null);
  const [createdAgent, setCreatedAgent] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!user || !ticket) return;
    let cancelled = false;
    request('preview', 'POST', { ticket }).then((data) => {
      if (!cancelled) {
        const parsed = previewSchema.parse(data);
        setPreview(parsed);
        setProjectId(parsed.projects[0]?.id ?? '');
        setChoice(parsed.choices.length ? '' : 'new');
      }
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
      let agentId = selected?.agentId;
      if (allow && choice === 'new') {
        agentId = createdAgent ?? undefined;
        if (!agentId) {
          const project = preview?.projects.find((p) => p.id === projectId);
          if (!project) throw new Error('Choose a project you own.');
          const pending = registration ?? { projectId, body: {
            operationId: crypto.randomUUID(), expectedVersion: project.version,
            name: name.trim(), client, owner: user!.name, machine: '', capabilities: [],
          } };
          setRegistration(pending);
          let result;
          try {
            result = await request(`/api/projects/${pending.projectId}/agents`, 'POST', pending.body);
          } catch (e) {
            if (e instanceof OAuthRequestError && e.status >= 400 && e.status < 500) {
              // A rejected registration can be edited. Uncertain network outcomes
              // retain the operation ID so retrying cannot create a duplicate.
              setRegistration(null);
              setPreview(previewSchema.parse(await request('preview', 'POST', { ticket })));
            }
            throw e;
          }
          const created = z.object({ entityId: z.string() }).parse(result);
          agentId = created.entityId;
          setCreatedAgent(agentId);
        }
      }
      const result = z.object({ redirectUrl: z.string().url() }).parse(await request('consent', 'POST', {
        ticket, allow, ...(allow ? { projectId: selected?.projectId ?? projectId, agentId } : {}),
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
      <Field label="Agent">
        <select disabled={busy || !!registration} value={choice} onChange={(e) => setChoice(e.target.value)}>
          <option value="">Choose an agent…</option>
          {preview.choices.map((c) => <option key={`${c.projectId}:${c.agentId}`} value={`${c.projectId}:${c.agentId}`}>
            {c.projectName} — {c.agentName}
          </option>)}
          <option value="new">Create a new agent</option>
        </select>
      </Field>
      {choice === 'new' && <>
        <Field label="Project"><select disabled={busy || !!registration} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">Choose a project…</option>
          {preview.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select></Field>
        <Field label="Agent name"><input disabled={busy || !!registration} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. My Codex" /></Field>
        <Field label="Agent client"><select disabled={busy || !!registration} value={client} onChange={(e) => setClient(e.target.value)}>
          <option>Codex</option><option>Claude Code</option><option>Other</option>
        </select></Field>
        {!preview.projects.length && <p>Create a project in Tandem first, then reconnect from your IDE.</p>}
      </>}
      <details><summary>Connection details</summary>
        <p className="break-all">Callback: {preview.redirectUri}</p>
        <p className="break-all text-sm">Client ID: {preview.clientId}</p>
      </details>
      <p>This allows the client to use available agent tools for the selected project. It does not grant human approval permissions. The connection expires after 30 days and can be disconnected earlier.</p>
      <div className="flex gap-3">
        <Button disabled={busy || !choice || (choice === 'new' && (!projectId || !name.trim()))} onClick={() => void decide(true)}>Allow connection</Button>
        <Button variant="outline" disabled={busy} onClick={() => void decide(false)}>Deny</Button>
      </div>
    </> : !error && <p role="status">Loading authorization request…</p>}
    {(error || sessionError) && <p role="alert">{error || sessionError?.message}</p>}
    <Link to="/dashboard">Return to dashboard</Link>
  </main>;
}

// One line per connected agent client, with its expiry and a Disconnect button.
export function McpConnectionList() {
  const { user } = useSession();
  const request = useOAuthRequest();
  const [connections, setConnections] = useState<z.infer<typeof connectionsSchema> | null>(null);
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
  return <>
    {connections === null && !error && <p role="status" className="muted">Loading connections…</p>}
    {connections?.length === 0 && !error && <p className="muted">No connected agents.</p>}
    {!!connections?.length && <ul className="connection-list">
      {connections.map((c) => <li key={c.id}>
        <span className="connection-name">{c.clientName || 'MCP client'} — {c.projectName} / {c.agentName}</span>
        <span className="connection-expiry muted" title={new Date(c.expiresAt).toLocaleString()}>
          Expires {new Date(c.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
        </span>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void disconnect(c.id)}>Disconnect</Button>
      </li>)}
    </ul>}
    {error && <p role="alert" className="notice error">{error}</p>}
  </>;
}

export function McpConnectionsPage() {
  const { user, signIn, error: sessionError } = useSession();
  return <main className="p-8 max-w-2xl mx-auto space-y-6">
    <h1 className="text-3xl font-bold">Connected MCP clients</h1>
    {!user ? <Button onClick={() => void signIn('/mcp/connections')}>Sign in</Button> : <McpConnectionList />}
    {sessionError && <p role="alert">{sessionError.message}</p>}
    <Link to="/dashboard">Return to dashboard</Link>
  </main>;
}
