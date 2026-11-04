import { useRef, useState, type ReactNode } from 'react';
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

function WorkerSetup({ project, agent, url, initialClient, roomPrompt, firstTimeIntro }: { project: Project; agent?: Agent; url: string; initialClient: string; roomPrompt: string; firstTimeIntro: ReactNode }) {
  const [tab, setTab] = useState<'first' | 'reconnect'>('first');
  const [engine, setEngine] = useState(initialClient === 'Claude Code' ? 'claude' : initialClient === 'Codex' ? 'codex' : 'custom');
  const [custom, setCustom] = useState('');
  const [verification, setVerification] = useState('');
  const [resumeTaskId, setResumeTaskId] = useState('');
  const sandboxSetup = 'npm install -g @anthropic-ai/sandbox-runtime@0.0.81';
  const codexSetup = 'npm install -g @openai/codex@latest @anthropic-ai/sandbox-runtime@0.0.81\ncodex login\ncodex login status';
  // The native installer uses ~/.local/bin; make it available in this terminal
  // immediately so the login commands and runner can find the new executable.
  const claudeSetup = `curl -fsSL https://claude.ai/install.sh | bash\nexport PATH="$HOME/.local/bin:$PATH"\n${sandboxSetup}\nclaude auth login\nclaude auth status`;
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const repositoryValid = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(project.repository)
    && project.repository.split('/').every(part => part !== '.' && part !== '..');
  const ready = repositoryValid && (engine !== 'custom' || !!custom.trim());
  const verificationArgs = verification.split('\n').map(line => line.trim()).filter(Boolean)
    .map(command => ` --verify-command ${quote(command)}`).join('');
  const argumentsText = `--prompt-token --project ${quote(project.id)} --url ${quote(url)} --repository ${quote(project.repository)}${agent ? ` --agent-id ${quote(agent.id)}` : ''} ${engine === 'custom' ? `--agent-command ${quote(custom.trim() || 'YOUR_AGENT_COMMAND')}` : `--agent ${engine}`}${verificationArgs}`;
  // The frontend serves the runner; absolute install and managed workspace paths
  // let users run this command from any terminal directory.
  const installCommand = `mkdir -p "$HOME/Downloads" &&\ncurl -fLsS ${quote(new URL('/downloads/tandem_runner.py', window.location.origin).href)} \\\n  -o "$HOME/Downloads/tandem_runner.py" &&\npython3 "$HOME/Downloads/tandem_runner.py" ${argumentsText}`;
  const resumableTasks = agent ? project.tasks.filter(task =>
    (task.agentId === agent.id || task.assignedAgentId === agent.id)
    && ['blocked', 'claimed', 'in_progress'].includes(task.status)) : [];
  const resumeCommand = resumeTaskId ? `${installCommand} --resume-task ${quote(resumeTaskId)}` : '';
  return <>
  <div className="setup-tabs" role="tablist" aria-label="Agent setup guide" onKeyDown={event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'first' : event.key === 'End' ? 'reconnect' : tab === 'first' ? 'reconnect' : 'first';
    setTab(next);
    event.currentTarget.querySelector<HTMLElement>(`#setup-${next}-tab`)?.focus();
  }}>
    <button type="button" role="tab" id="setup-first-tab" aria-controls="setup-first-panel" aria-selected={tab === 'first'} tabIndex={tab === 'first' ? 0 : -1} onClick={() => setTab('first')}>First-time setup</button>
    <button type="button" role="tab" id="setup-reconnect-tab" aria-controls="setup-reconnect-panel" aria-selected={tab === 'reconnect'} tabIndex={tab === 'reconnect' ? 0 : -1} onClick={() => setTab('reconnect')}>Reconnecting</button>
  </div>
  <div role="tabpanel" id="setup-first-panel" aria-labelledby="setup-first-tab" hidden={tab !== 'first'}>
    {firstTimeIntro}
  <section aria-label="Continuous worker setup" className="agent-advanced">
    <h3>2. Choose your worker</h3>
    <p>Automatically work on assigned, approved tasks and answer room pings. No access to Tandem’s private repository is needed.</p>
    <Field label="Worker engine"><select value={engine} onChange={e => setEngine(e.target.value)}>
      <option value="codex">Codex CLI</option><option value="claude">Claude Code CLI</option><option value="custom">Other command</option>
    </select></Field>
    {engine === 'custom' && <Field label="Agent command"><input value={custom} onChange={e => setCustom(e.target.value)} placeholder="Your headless command" /></Field>}
    {engine === 'custom' && <p className="small muted">Accept tasks on stdin, run without prompts, and leave edits for the runner to verify and commit. Sign in before starting.</p>}
    {engine === 'codex' && <section aria-label="Codex CLI setup">
      <p>Install Codex and the verification sandbox, then finish browser sign-in. Requires Node.js/npm.</p>
      <pre className="oauth-code">{codexSetup}</pre>
      <CopyButton text={codexSetup} label="Copy Codex setup commands" />
    </section>}
    {engine === 'claude' && <section aria-label="Claude CLI setup">
      <p>Install Claude Code and the verification sandbox, then finish browser sign-in. Requires Node.js/npm.</p>
      <pre className="oauth-code">{claudeSetup}</pre>
      <CopyButton text={claudeSetup} label="Copy Claude setup commands" />
    </section>}
    {engine === 'custom' && <section aria-label="Verification sandbox setup">
      <p>Install the verification sandbox. Requires Node.js/npm.</p>
      <pre className="oauth-code">{sandboxSetup}</pre>
      <CopyButton text={sandboxSetup} label="Copy sandbox setup command" />
    </section>}
    <details className="agent-advanced"><summary>Verification (optional)</summary>
      <p className="small muted">Runs root typecheck, lint, test and build scripts in an OS sandbox with an isolated environment and no network access. Other commands below replace these checks. Missing sandbox, denied access or failed checks stop the push; checks never fall back to the host.</p>
      <Field label="Verification commands"><textarea value={verification} onChange={e => setVerification(e.target.value)} placeholder="npm run test:e2e" /></Field>
    </details>
    <p>Tandem prepares <strong>{project.repository}</strong> automatically with a separate worktree per agent. Verified commits are pushed only to <strong>{project.trackedBranch?.trim() || 'main'}</strong>, as configured in Project setup.</p>
    {!repositoryValid && <p role="alert">Set this project’s GitHub repository to owner/repository before starting a worker.</p>}
    <p className="small muted">macOS/Linux: Python 3.11+, curl, Git, and signed-in GitHub CLI (gh auth login) and agent CLI. Linux verification also requires bubblewrap and socat.</p>
    <h3>3. Get your agent token</h3>
    {agent ? <><p>Copy this agent’s token for the terminal prompt.</p><AgentTokenButton project={project} agent={agent} /></>
      : <p>After connecting, open Set up worker on your agent to get its token.</p>}
    <section aria-label="Download and start worker">
      <h3>4. Download and start</h3>
      <p>{ready ? 'Run in your project folder to reuse it, or anywhere to download it automatically. Paste the token when prompted, then press Enter. Pasted text stays hidden.' : 'Complete step 2 to enable copying.'}</p>
      {engine === 'custom' && !custom.trim() && <p className="small muted">Also enter your headless agent command in step 2.</p>}
      <pre className="oauth-code">{installCommand}</pre>
      <CopyButton key={installCommand} text={installCommand} label="Copy download and start command" disabled={!ready} />
    </section>
    <p className="small muted">Saves the runner to Downloads. Keep the terminal open; Ctrl+C stops it. The runner verifies, commits, and pushes only to the branch configured in Project setup; you review and accept the work.</p>
  </section>
  <section aria-label="Agent startup prompt" className="agent-advanced">
    <h3>5. Start your agent chat</h3>
    <p>Paste into your connected agent’s chat. Keep the terminal worker running for continuous work.</p>
    <pre className="oauth-code">{roomPrompt}</pre>
    <CopyButton text={roomPrompt} label="Copy startup prompt" />
  </section>
  </div>
  <div role="tabpanel" id="setup-reconnect-panel" aria-labelledby="setup-reconnect-tab" hidden={tab !== 'reconnect'}>
  <section aria-label="Reconnect your worker" className="oauth-step worker-reconnect">
    <h3>Restart your worker</h3>
    <p>Run this command again to reuse this agent’s workspace. Paste the agent token at the hidden prompt and press Enter. You do not need to reconnect MCP.</p>
    <pre className="oauth-code">{installCommand}</pre>
    <CopyButton key={installCommand} text={installCommand} label="Copy download and start command" disabled={!ready} />
    {!ready && <p className="small muted">Complete the worker settings in First-time setup to enable copying.</p>}
    <h3>Resume saved task changes</h3>
    <p><strong>Saved changes:</strong> If setup says “Use a clean, dedicated clone,” this agent’s workspace has uncommitted task work. Your current terminal folder is not the cause. Do not delete or reset the workspace.</p>
    {agent ? <>
      <Field label="Task to resume" hint="Choose the blocked or active task that owns those saved changes.">
        <select value={resumeTaskId} onChange={event => setResumeTaskId(event.target.value)}>
          <option value="">Select a task</option>
          {resumableTasks.map(task => <option key={task.id} value={task.id}>{task.title} · {task.status}</option>)}
        </select>
      </Field>
      {resumableTasks.length === 0 && <p className="small muted">No assigned blocked or active tasks are shown. Check Workflow before changing the saved workspace.</p>}
      {resumeTaskId && <>
        <p>Run this command to continue that task and preserve its saved edits:</p>
        <pre className="oauth-code">{resumeCommand}</pre>
        <CopyButton key={resumeCommand} text={resumeCommand} label="Copy resume command" disabled={!ready} />
      </>}
    </> : <p className="small muted">After connecting, open Set up worker for this agent to choose a task and get its resume command.</p>}
  </section>
  </div>
  </>;
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
  const roomPrompt = `Use Tandem for project ${project.id}.
Confirm access with tandem_whoami. Fetch tandem_get_assignments and summarize ready work and blockers.
Check tandem_get_presence_requests; acknowledge returned IDs with tandem_acknowledge_presence. Repeat between tasks.
Check tandem_get_worker_room_requests between task steps. Answer messages addressed to you with tandem_reply_worker_room_request, using the same request ID. Other human room messages remain private.
Before claiming work, read repo instructions, git status, the approved contract and dependencies. Preserve others’ changes and report progress, questions, tests and blockers through Tandem. Retry the same write with its original operation ID.
Never approve or merge your own work, access human room messages, or duplicate a running worker’s tasks. Continuous work while this chat is idle requires the terminal worker.`;
  const snippet = url && (client === 'Claude Code'
    ? JSON.stringify({ mcpServers: { 'tandem-oauth': { type: 'http', url } } }, null, 2)
    : `# Tandem remote MCP connection. Authentication happens in your browser.\n[mcp_servers.tandem-oauth]\nurl = ${JSON.stringify(url)}`);
  const firstTimeIntro = connections.data ? <>
      <h3>1. Connect your agent — complete</h3>
      <p>Your agent has permission to access this project.</p>
    </> : step === 1 ? <>
      <h3>1. Connect your agent</h3>
      <Field label="Your agent">
        <select value={client} onChange={(e) => setClient(e.target.value)}>
          <option>Codex</option><option>Claude Code</option><option>Other</option>
        </select>
      </Field>
      <p>Add this remote HTTP MCP server in your agent’s app, CLI, or IDE. Sign in through your browser.</p>
      <Field label="Server URL"><input readOnly value={url} onFocus={(e) => e.currentTarget.select()} /></Field>
      <CopyButton key={url} text={url!} label="Copy server URL" />
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
      {url && new URL(url).protocol === 'http:' && <p className="small muted">Local setup: keep Tandem running on this computer. Use your hosted server for other machines.</p>}
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
    </>;
  return <Modal open onOpenChange={(open) => { if (!open) onClose(); }}
    title={connections.data ? 'Access authorized' : 'Connect your agent'}
    description={agent ? `${agent.name} · ${project.name}` : project.name} className="agent-setup-dialog">
    {discovery.isPending && <p role="status">Checking your server…</p>}
    <ErrorNotice error={discovery.error} retry={() => void discovery.refetch()} />
    {url && <WorkerSetup key={`${agent?.id ?? String(connections.data)}:${client}`} project={project}
      agent={agent ?? project.agents.find(a => a.id === connections.data)} url={url} initialClient={client} roomPrompt={roomPrompt} firstTimeIntro={firstTimeIntro} />}
    <div className="row between wrap oauth-step">
      <Link to="/mcp/connections" onClick={onClose}>Manage connections</Link>
      <Button variant="outline" onClick={() => { void queries.invalidateQueries({ queryKey: ['workspace'] }); onClose(); }}>Done</Button>
    </div>
  </Modal>;
}
