import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth0 } from '@auth0/auth0-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { configuration } from '../config';
import { useSession } from '../auth/session';
import type { Agent, Project } from '../types/domain';
import { Button } from './ui/button';
import { Modal } from './ui/dialog';
import { ErrorNotice, Field } from './common';

// Use discovery as the source of truth: localhost and 127.0.0.1 are different
// OAuth resource identifiers even when they reach the same development server.
export function useMcpDiscovery() {
  const base = configuration.config?.apiBaseUrl;
  return useQuery({
    queryKey: ['mcp-discovery', base],
    enabled: !!base,
    retry: false,
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const response = await fetch(`${base}/.well-known/oauth-protected-resource/mcp/`, {
        signal, credentials: 'omit', cache: 'no-store', redirect: 'error',
      });
      if (!response.ok) throw new Error(response.status === 404
        ? 'OAuth is not enabled on this backend. Enable it and restart the backend, then retry.'
        : 'Could not check OAuth availability. Check that your backend is running.');
      const metadata = z.object({ resource: z.string().url() }).parse(await response.json());
      const url = new URL(metadata.resource);
      if (url.username || url.password || url.search || url.hash ||
        !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
        throw new Error('The backend advertised an invalid MCP URL. Check its OAuth issuer setting.');
      }
      return metadata.resource;
    },
  });
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return <>
    <Button variant="outline" size="sm" onClick={async () => {
      try { await navigator.clipboard.writeText(text); setCopied(true); setFailed(false); }
      catch { setFailed(true); }
    }}>{copied ? 'Copied' : label}</Button>
    {failed && <p role="alert">Clipboard unavailable. Select the text above and copy it manually.</p>}
  </>;
}

export function AgentOAuthSetup({ project, agent, onClose }: {
  project: Project; agent: Agent; onClose: () => void;
}) {
  const discovery = useMcpDiscovery();
  const { user } = useSession();
  const { getAccessTokenSilently } = useAuth0();
  const queries = useQueryClient();
  const [client, setClient] = useState<string>(agent.client);
  const connections = useQuery({
    queryKey: ['mcp-onboarding', user?.id, project.id, agent.id],
    enabled: !!discovery.data && !!user,
    retry: false,
    refetchInterval: 5000,
    queryFn: async ({ signal }) => {
      const token = await getAccessTokenSilently();
      const response = await fetch(`${configuration.config!.apiBaseUrl}/api/mcp/oauth/connections`, {
        signal, credentials: 'omit', cache: 'no-store', redirect: 'error',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error('Could not check authorization. Sign in again or retry.');
      return z.array(z.object({ agentId: z.string(), projectId: z.string() }))
        .parse(await response.json()).some((c) => c.agentId === agent.id && c.projectId === project.id);
    },
  });
  const url = discovery.data;
  const snippet = url && (client === 'Claude Code'
    ? JSON.stringify({ mcpServers: { 'tandem-oauth': { type: 'http', url } } }, null, 2)
    : `# Tandem remote MCP connection. Authentication happens in your browser.\n[mcp_servers.tandem-oauth]\nurl = ${JSON.stringify(url)}`);
  return <Modal open onOpenChange={(open) => { if (!open) onClose(); }}
    title={`Connect ${agent.name} with OAuth`}
    description={`Authorize your IDE agent to access ${project.name}. Keep this window open while you finish sign-in.`}>
    {discovery.isPending && <p role="status">Checking your MCP server…</p>}
    <ErrorNotice error={discovery.error} retry={() => void discovery.refetch()} />
    {url && <>
      <section className="oauth-step">
        <h3>1. Add Tandem to your IDE</h3>
        <Field label="Agent client">
          <select value={client} onChange={(e) => setClient(e.target.value)}>
            <option>Codex</option><option>Claude Code</option><option>Other</option>
          </select>
        </Field>
        <Field label="Remote MCP server URL">
          <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
        </Field>
        <CopyButton key={url} text={url} label="Copy MCP URL" />
        {client === 'Codex' ? <>
          <p>In Codex, open MCP settings and add a remote HTTP server named <strong>tandem-oauth</strong> using this URL.</p>
          <details><summary>Set up using the configuration file</summary>
            <p>Open your personal <code>~/.codex/config.toml</code> from Codex settings. Add or update this entry in the file, then reload the extension.</p>
            <pre className="oauth-code">{snippet}</pre>
            <CopyButton text={snippet!} label="Copy configuration" />
            <p>This is file content, not a terminal command.</p>
          </details>
          <a href="https://developers.openai.com/codex/mcp/" target="_blank" rel="noreferrer">Codex MCP setup documentation</a>
        </> : client === 'Claude Code' ? <>
          <p>Add this entry to <code>.mcp.json</code> in your project, merging it with any existing servers. Reload Claude Code and approve the project server if prompted.</p>
          <pre className="oauth-code">{snippet}</pre>
          <CopyButton text={snippet!} label="Copy configuration" />
          <a href="https://code.claude.com/docs/en/mcp" target="_blank" rel="noreferrer">Claude Code MCP setup documentation</a>
        </> : <p>Add a remote HTTP MCP server with this URL in your client's settings. The client must support OAuth.</p>}
        <p className="small muted">Leave bearer tokens and Authorization headers empty for this entry.</p>
        {new URL(url).protocol === 'http:' && <p className="small muted">This address works on your machine. Keep the backend and dashboard running. Your friend will need the hosted URL or their own local setup.</p>}
      </section>
      <section className="oauth-step">
        <h3>2. Sign in from your IDE</h3>
        <p>{client === 'Claude Code'
          ? 'Open /mcp in Claude Code, select tandem-oauth, and authenticate.'
          : 'Select the sign-in or authenticate action for tandem-oauth in your MCP client.'}</p>
        <p>In the browser, sign in to Tandem and choose <strong>{project.name} — {agent.name}</strong>, then select <strong>Allow connection</strong>.</p>
        <p className="small muted">Your IDE starts the sign-in flow. Copying the URL alone does not authorize access.</p>
      </section>
      <section className="oauth-step" aria-live="polite">
        <h3>3. Verify access</h3>
        <p>{connections.data ? '✓ OAuth access authorized for this agent and project.' : 'Waiting for authorization. This window checks automatically.'}</p>
        <ErrorNotice error={connections.error} />
        <Button variant="outline" disabled={connections.isFetching} onClick={() => {
          void connections.refetch();
          void queries.invalidateQueries({ queryKey: ['workspace'] });
        }}>Check authorization</Button>
        <p>Ask your IDE agent:</p>
        <pre className="oauth-code">Call tandem_whoami from tandem-oauth.</pre>
        <CopyButton text="Call tandem_whoami from tandem-oauth." label="Copy test prompt" />
        <p>Confirm the result names <strong>{agent.name}</strong> and <strong>{project.name}</strong>. Authorization does not start an agent session; the presence indicator may still say Offline.</p>
      </section>
    </>}
    <div className="row between wrap">
      <Link to="/mcp/connections" onClick={onClose}>Manage authorized connections</Link>
      <Button onClick={() => { void queries.invalidateQueries({ queryKey: ['workspace'] }); onClose(); }}>Done</Button>
    </div>
  </Modal>;
}
