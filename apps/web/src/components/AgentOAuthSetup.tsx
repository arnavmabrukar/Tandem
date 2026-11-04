import { useRef, useState } from 'react';
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
import { AgentTokenButton } from './AgentTokenButton';

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

function CopyButton({ text, label, disabled = false }: { text: string; label: string; disabled?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return <>
    <Button variant="outline" size="sm" disabled={disabled} onClick={async () => {
      try { await navigator.clipboard.writeText(text); setCopied(true); setFailed(false); }
      catch { setFailed(true); }
    }}>{copied ? 'Copied' : label}</Button>
    {failed && <p role="alert">Clipboard unavailable. Select the text above and copy it manually.</p>}
  </>;
}

function WorkerSetup({ project, agent, url, initialClient }: { project: Project; agent?: Agent; url: string; initialClient: string }) {
  const [engine, setEngine] = useState(initialClient === 'Claude Code' ? 'claude' : initialClient === 'Codex' ? 'codex' : 'custom');
  const [custom, setCustom] = useState('');
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const repositoryValid = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(project.repository)
    && project.repository.split('/').every(part => part !== '.' && part !== '..');
  const ready = repositoryValid && (engine !== 'custom' || !!custom.trim());
  const argumentsText = `--prompt-token --project ${quote(project.id)} --url ${quote(url)} --repository ${quote(project.repository)}${agent ? ` --agent-id ${quote(agent.id)}` : ''} ${engine === 'custom' ? `--agent-command ${quote(custom.trim() || 'YOUR_AGENT_COMMAND')}` : `--agent ${engine}`}`;
  // The frontend serves the runner; absolute install and managed workspace paths
  // let users run this command from any terminal directory.
  const installCommand = `mkdir -p "$HOME/Downloads" &&\ncurl -fLsS ${quote(new URL('/downloads/tandem_runner.py', window.location.origin).href)} \\\n  -o "$HOME/Downloads/tandem_runner.py" &&\npython3 "$HOME/Downloads/tandem_runner.py" ${argumentsText}`;
  return <section aria-label="Continuous worker setup" className="agent-advanced">
    <h3>2. Choose your worker</h3>
    <p>Start a worker to handle assigned, approved tasks and answer room pings automatically. No access to Tandem’s private repository is needed.</p>
    <Field label="Worker engine"><select value={engine} onChange={e => setEngine(e.target.value)}>
      <option value="codex">Codex CLI</option><option value="claude">Claude Code CLI</option><option value="custom">Other command</option>
    </select></Field>
    {engine === 'custom' && <Field label="Agent command"><input value={custom} onChange={e => setCustom(e.target.value)} placeholder="Your headless command" /></Field>}
    {engine === 'custom' && <p className="small muted">The command must accept the task on stdin, complete it without interactive prompts, and commit its changes before exiting. Verify its login separately.</p>}
    <p>The runner downloads to your Downloads folder and prepares an agent worktree for <strong>{project.repository}</strong> automatically. Agents share the repository, work on their own task branches, and resolve conflicts with the base branch before submitting work. Your GitHub account needs access to this project.</p>
    {!repositoryValid && <p role="alert">Set this project’s GitHub repository to owner/repository before starting a worker.</p>}
    <p className="small muted">Requires Python 3.11+, curl, Git, and signed-in GitHub and agent CLIs on macOS/Linux.</p>
    <h3>3. Get your agent token</h3>
    {agent ? <><p>Have this agent’s token ready for the terminal prompt.</p><AgentTokenButton project={project} agent={agent} /></>
      : <p>After connecting, open your agent’s Set up worker control to get its token.</p>}
    <section aria-label="Download and start worker">
      <h3>4. Download and start</h3>
      <p>{ready ? 'Run this from your project folder to reuse its repository, or from any folder to let Tandem download it. Enter the agent token when prompted.' : 'Complete the required setup in step 2 to enable copying.'}</p>
      {engine === 'custom' && !custom.trim() && <p className="small muted">Also enter your headless agent command in step 2.</p>}
      <pre className="oauth-code">{installCommand}</pre>
      <CopyButton key={installCommand} text={installCommand} label="Copy download and start command" disabled={!ready} />
    </section>
    <p className="small muted">The worker pushes task branches and opens PRs; approvals and merges stay with you. Keep the terminal open. Ctrl+C stops it.</p>
  </section>;
}

export function AgentOAuthSetup({ project, agent, onClose }: {
  project: Project; agent?: Agent; onClose: () => void;
}) {
  const discovery = useMcpDiscovery();
  const { user } = useSession();
  const { getAccessTokenSilently } = useAuth0();
  const queries = useQueryClient();
  const [client, setClient] = useState<string>(agent?.client ?? 'Codex');
  const [step, setStep] = useState(1);
  const initialConnections = useRef<Set<string> | null>(null);
  const connections = useQuery({
    queryKey: ['mcp-onboarding', user?.id, project.id, agent?.id],
    enabled: !!discovery.data && !!user,
    retry: false,
    refetchInterval: 5000,
    queryFn: async ({ signal }) => {
      const token = await getAccessTokenSilently();
      const response = await fetch(`${configuration.config!.apiBaseUrl}/api/mcp/oauth/connections`, {
        signal, credentials: 'omit', cache: 'no-store', redirect: 'error',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        // Only authentication failures call for another sign-in. Storage and
        // deployment failures need a backend fix, not repeated login attempts.
        const explanation = response.status === 401
          ? 'Your dashboard sign-in expired. Sign out and sign in again.'
          : response.status === 403
            ? 'Your account cannot check these connections.'
            : response.status === 404
              ? 'This backend does not expose OAuth connections. Check its deployment and OAuth setting.'
              : response.status === 503
                ? 'OAuth storage is unavailable. Check the backend database connection and migration 011.'
                : 'The backend could not check connections. Check its logs and retry.';
        throw new Error(`${explanation} (HTTP ${response.status})`);
      }
      const sessions = z.array(z.object({ id: z.string(), agentId: z.string(), projectId: z.string() }))
        .parse(await response.json()).filter((c) => c.projectId === project.id);
      if (agent) return sessions.find((c) => c.agentId === agent.id)?.agentId ?? false;
      // A pre-existing session must not count as completing this new setup.
      if (!initialConnections.current) initialConnections.current = new Set(sessions.map((c) => c.id));
      return sessions.find((c) => !initialConnections.current!.has(c.id))?.agentId ?? false;
    },
  });
  const url = discovery.data;
  const roomPrompt = `Use Tandem for project ${project.id}. Start with tandem_whoami and confirm project access. Check available tools and report any missing ones. Call tandem_get_presence_requests and acknowledge each returned ID with tandem_acknowledge_presence. Fetch tandem_get_assignments and summarize ready work and blockers. Before working, inspect repository instructions and git status, read the approved contract and dependencies, and claim the task. Preserve others' changes; report progress, questions, test results and blockers through Tandem. Reuse operation IDs only when retrying the same write. Never approve or merge your own work. Check presence between tasks. Human room messages remain private. Do not claim to listen while idle: continuous execution requires a separately running worker. If a worker already owns a task, do not execute it in this chat too.`;
  const snippet = url && (client === 'Claude Code'
    ? JSON.stringify({ mcpServers: { 'tandem-oauth': { type: 'http', url } } }, null, 2)
    : `# Tandem remote MCP connection. Authentication happens in your browser.\n[mcp_servers.tandem-oauth]\nurl = ${JSON.stringify(url)}`);
  return <Modal open onOpenChange={(open) => { if (!open) onClose(); }}
    title={connections.data ? 'Access authorized' : 'Connect your agent'}
    description={agent ? `${agent.name} · ${project.name}` : project.name}>
    {discovery.isPending && <p role="status">Checking your server…</p>}
    <ErrorNotice error={discovery.error} retry={() => void discovery.refetch()} />
    {url && (connections.data ? <>
      <h3>1. Connect your agent — complete</h3>
      <p>Your agent has permission to access this project.</p>
      <details className="agent-advanced"><summary>Optional agent chat prompt</summary>
      <pre className="oauth-code">{roomPrompt}</pre>
      <CopyButton text={roomPrompt} label="Copy startup prompt" />
      </details>
    </> : step === 1 ? <>
      <h3>1. Connect your agent</h3>
      <Field label="Your agent">
        <select value={client} onChange={(e) => setClient(e.target.value)}>
          <option>Codex</option><option>Claude Code</option><option>Other</option>
        </select>
      </Field>
      <p>Add Tandem as a remote MCP server in your agent’s app, CLI, or IDE using this address. Your client must support remote HTTP MCP and browser sign-in.</p>
      <Field label="Server URL"><input readOnly value={url} onFocus={(e) => e.currentTarget.select()} /></Field>
      <CopyButton key={url} text={url} label="Copy server URL" />
      <details className="agent-advanced">
        <summary>How to add it in {client}</summary>
        <p>{client === 'Claude Code'
          ? 'Add this to .mcp.json in your project, keeping any existing servers. Reload Claude Code and approve the server when prompted.'
          : client === 'Codex'
            ? 'Open MCP settings in your Codex client and add a remote HTTP server named tandem-oauth. For a local Codex client, you can also add this entry to ~/.codex/config.toml and restart the session.'
            : 'Use your client’s remote MCP settings. It must support browser sign-in.'}</p>
        {client !== 'Other' && <>
          <pre className="oauth-code">{snippet}</pre>
          <CopyButton key={snippet} text={snippet!} label="Copy configuration" />
          <p className="small muted">Paste this into the configuration file, not the terminal. Leave authentication headers empty.</p>
        </>}
      </details>
      {new URL(url).protocol === 'http:' && <p className="small muted">Local setup: keep Tandem running on this computer. Use your hosted server for other machines.</p>}
      <div className="row end"><Button onClick={() => setStep(2)}>Continue</Button></div>
    </> : <>
      <h3>1. Finish connecting your agent</h3>
      <p>{client === 'Claude Code'
        ? 'In Claude Code, open /mcp, choose tandem-oauth, then authenticate.'
        : 'In your agent client’s MCP settings, choose tandem-oauth and start sign-in.'}</p>
      <p>In the browser, choose <strong>{project.name}</strong>{agent ? <> and <strong>{agent.name}</strong></> : ' and name your agent'}, then click <strong>Allow connection</strong>.</p>
      <p role="status">Waiting for authorization…</p>
      <ErrorNotice error={connections.error} retry={() => void connections.refetch()} />
      <Button variant="outline" onClick={() => setStep(1)}>Back</Button>
    </>)}
    {url && <WorkerSetup key={`${agent?.id ?? String(connections.data)}:${client}`} project={project}
      agent={agent ?? project.agents.find(a => a.id === connections.data)} url={url} initialClient={client} />}
    <div className="row between wrap oauth-step">
      <Link to="/mcp/connections" onClick={onClose}>Manage connections</Link>
      <Button variant="outline" onClick={() => { void queries.invalidateQueries({ queryKey: ['workspace'] }); onClose(); }}>Done</Button>
    </div>
  </Modal>;
}
