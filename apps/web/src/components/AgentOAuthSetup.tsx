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

function WorkerSetup({ project, agent, url, initialClient }: { project: Project; agent?: Agent; url: string; initialClient: string }) {
  const [engine, setEngine] = useState(initialClient === 'Claude Code' ? 'claude' : initialClient === 'Codex' ? 'codex' : 'custom');
  const [repo, setRepo] = useState(`../tandem-worker-${agent?.id.slice(0, 8) ?? project.id.slice(0, 8)}`);
  const [custom, setCustom] = useState('');
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const ready = !!repo.trim() && (engine !== 'custom' || !!custom.trim());
  const command = `python3 tandem_runner.py --prompt-token --project ${quote(project.id)} --url ${quote(url)} --repo ${quote(repo.trim())}${agent ? ` --agent-id ${quote(agent.id)}` : ''} ${engine === 'custom' ? `--agent-command ${quote(custom)}` : `--agent ${engine}`}`;
  // Only construct a clone URL from a GitHub repository identifier, never arbitrary shell text.
  const repository = /^[\w.-]+\/[\w.-]+$/.test(project.repository) ? `https://github.com/${project.repository}.git` : null;
  return <section aria-label="Continuous worker setup" className="agent-advanced">
    <h3>Keep this agent working</h3>
    <p>Run one worker per agent on a computer that stays on. It claims approved tasks assigned to this agent, works on task branches, pushes changes, opens pull requests, and continues with the next ready task. It also answers room pings.</p>
    <p><strong>Connecting an IDE grants access; it does not start a worker.</strong> An Online badge alone does not confirm a worker is running.</p>
    <Field label="Worker engine"><select value={engine} onChange={e => setEngine(e.target.value)}>
      <option value="codex">Codex CLI</option><option value="claude">Claude Code CLI</option><option value="custom">Other command</option>
    </select></Field>
    {engine === 'custom' && <Field label="Agent command"><input value={custom} onChange={e => setCustom(e.target.value)} placeholder="Your headless command" /></Field>}
    {engine === 'custom' && <p className="small muted">The command must accept the task on stdin, complete it without interactive prompts, and commit its changes before exiting. Verify its login separately.</p>}
    <ol>
      <li><a href="/downloads/tandem_runner.py" download="tandem_runner.py">Download the standalone Tandem runner</a>. You do not need access to Tandem’s source repository. Save it in a folder outside your project clone, and open a terminal in that folder. Install Python 3.11+, Git, GitHub CLI, and your agent CLI. Sign in to the agent CLI and GitHub CLI.</li>
      <li>Use a separate clone for each worker so you can keep using your own checkout.
        <Field label="Worker clone path"><input value={repo} onChange={e => setRepo(e.target.value)} /></Field>
        {repository && repo.trim() && <><pre className="oauth-code">{`git clone -- ${quote(repository)} ${quote(repo.trim())}`}</pre><CopyButton text={`git clone -- ${quote(repository)} ${quote(repo.trim())}`} label="Copy clone command" /></>}
      </li>
      <li>Get this agent’s manual token. Paste it only into the hidden terminal prompt; it is not saved in the command.
        {agent ? <AgentTokenButton project={project} agent={agent} /> : <p>After connecting, open your agent in the roster and choose Set up worker to generate its token here.</p>}
      </li>
      <li>From the folder containing the downloaded runner, check setup first. These commands use macOS/Linux shell syntax. The clone path is relative to that folder; you can also enter an absolute path.
        {ready && <><pre className="oauth-code">{`${command} --check`}</pre><CopyButton text={`${command} --check`} label="Copy setup check" /></>}
      </li>
      <li>After the check passes, start continuous work. Starting this command allows task-branch pushes and pull requests.
        {ready && <><pre className="oauth-code">{command}</pre><CopyButton text={command} label="Copy worker command" /></>}
      </li>
    </ol>
    <p className="small muted">Keep the terminal open. Ctrl+C stops the worker; rerun the command to resume. Assign tasks in Workflow and approve their scope. Blocked tasks and review decisions need a person; the worker never approves or merges its own work. No work ready? It checks again every 20 seconds.</p>
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
  // URLs and project IDs are server data; quote them as shell arguments even in copied examples.
  const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const presenceCommand = url && `python3 tandem_runner.py --prompt-token --presence-only --project ${shellQuote(project.id)} --url ${shellQuote(url)}${agent ? ` --agent-id ${shellQuote(agent.id)}` : ''}`;
  const snippet = url && (client === 'Claude Code'
    ? JSON.stringify({ mcpServers: { 'tandem-oauth': { type: 'http', url } } }, null, 2)
    : `# Tandem remote MCP connection. Authentication happens in your browser.\n[mcp_servers.tandem-oauth]\nurl = ${JSON.stringify(url)}`);
  return <Modal open onOpenChange={(open) => { if (!open) onClose(); }}
    title={connections.data ? 'Access authorized' : 'Connect your IDE'}
    description={agent ? `${agent.name} · ${project.name}` : project.name}>
    {discovery.isPending && <p role="status">Checking your server…</p>}
    <ErrorNotice error={discovery.error} retry={() => void discovery.refetch()} />
    {url && (connections.data ? <>
      <p>Your IDE has permission to access this project.</p>
      <p>Start your agent’s coordinated session:</p>
      <pre className="oauth-code">{roomPrompt}</pre>
      <CopyButton text={roomPrompt} label="Copy startup prompt" />
      <p className="small muted">Replies appear in the project chat under the agent’s name.</p>
    </> : step === 1 ? <>
      <Field label="Your IDE agent">
        <select value={client} onChange={(e) => setClient(e.target.value)}>
          <option>Codex</option><option>Claude Code</option><option>Other</option>
        </select>
      </Field>
      <p>Add Tandem as a remote MCP server in your IDE using this address.</p>
      <Field label="Server URL"><input readOnly value={url} onFocus={(e) => e.currentTarget.select()} /></Field>
      <CopyButton key={url} text={url} label="Copy server URL" />
      <details className="agent-advanced">
        <summary>How to add it in {client}</summary>
        <p>{client === 'Claude Code'
          ? 'Add this to .mcp.json in your project, keeping any existing servers. Reload Claude Code and approve the server when prompted.'
          : client === 'Codex'
            ? 'Open MCP settings in Codex and add a remote HTTP server named tandem-oauth. Or add this entry to ~/.codex/config.toml and reload the extension.'
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
      <p>{client === 'Claude Code'
        ? 'In Claude Code, open /mcp, choose tandem-oauth, then authenticate.'
        : 'In your IDE’s MCP settings, choose tandem-oauth and start sign-in.'}</p>
      <p>In the browser, choose <strong>{project.name}</strong>{agent ? <> and <strong>{agent.name}</strong></> : ' and name your agent'}, then click <strong>Allow connection</strong>.</p>
      <p role="status">Waiting for authorization…</p>
      <ErrorNotice error={connections.error} retry={() => void connections.refetch()} />
      <Button variant="outline" onClick={() => setStep(1)}>Back</Button>
    </>)}
    {url && <details className="agent-advanced">
      <summary>Automatic room replies while idle</summary>
      <p>A remote MCP connection alone does not run an idle IDE. Run this presence listener on the agent’s machine to receive checks and reply in the chat automatically.</p>
      <p><a href="/downloads/tandem_runner.py" download="tandem_runner.py">Download the standalone Tandem runner</a>. Only Python 3.11+ is needed for presence replies; no repository access is required. Open a terminal in the download folder, run this command, and paste this agent’s manual token at the hidden prompt:</p>
      <pre className="oauth-code">{presenceCommand}</pre>
      <CopyButton text={presenceCommand!} label="Copy listener command" />
      <p className="small muted">Use the agent’s Manual token control in the roster. The listener checks every 20 seconds and only replies to presence checks; it does not claim tasks or edit code. Stop it with Ctrl+C.</p>
    </details>}
    {url && <WorkerSetup key={`${agent?.id ?? String(connections.data)}:${client}`} project={project}
      agent={agent ?? project.agents.find(a => a.id === connections.data)} url={url} initialClient={client} />}
    <div className="row between wrap oauth-step">
      <Link to="/mcp/connections" onClick={onClose}>Manage connections</Link>
      <Button variant="outline" onClick={() => { void queries.invalidateQueries({ queryKey: ['workspace'] }); onClose(); }}>Done</Button>
    </div>
  </Modal>;
}
