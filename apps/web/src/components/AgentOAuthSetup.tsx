import { useEffect, useRef, useState, type ReactNode } from 'react';
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
import { ago } from '../pages/overview';
import { Check, CircleCheck, Copy } from 'lucide-react';

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

function CopyButton({ text, label, disabled = false, iconOnly = false }: { text: string; label: string; disabled?: boolean; iconOnly?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return <>
    <Button variant="outline" size="sm" className="copy-button" disabled={disabled} aria-label={label} title={copied ? 'Copied' : label} onClick={async () => {
      try { await navigator.clipboard.writeText(text); setCopied(true); setFailed(false); }
      catch { setFailed(true); }
    }}>{iconOnly ? (copied ? <Check size={17} /> : <Copy size={17} />) : copied ? 'Copied' : label}</Button>
    {copied && <span role="status" className="sr-only">Copied to clipboard</span>}
    {failed && <p role="alert" className="copy-failed">Clipboard unavailable. Select the text and copy it manually.</p>}
  </>;
}

type WorkerPlatform = 'macos' | 'linux' | 'windows';
const platformNames: Record<WorkerPlatform, string> = { macos: 'macOS', linux: 'Linux', windows: 'Windows (WSL 2)' };
const platformShell: Record<WorkerPlatform, string> = { macos: 'Terminal', linux: 'Linux shell', windows: 'Ubuntu / WSL terminal' };
const PLATFORM_KEY = 'tandem-worker-os';

// One choice for the whole guide: the saved one, else the computer this browser is running on.
function initialPlatform(): WorkerPlatform {
  try {
    const saved = localStorage.getItem(PLATFORM_KEY);
    if (saved === 'macos' || saved === 'linux' || saved === 'windows') return saved;
  } catch { /* Storage can be blocked; fall back to the browser's own platform. */ }
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return /Windows/i.test(agent) ? 'windows' : /Mac|iPhone|iPad/i.test(agent) ? 'macos' : 'linux';
}

function OsPicker({ platform, onChange, id }: { platform: WorkerPlatform; onChange: (value: WorkerPlatform) => void; id: string }) {
  return <div className="os-picker" role="radiogroup" aria-labelledby={`os-label-${id}`}>
    <span id={`os-label-${id}`} className="os-label">Your computer</span>
    <div className="os-options">
      {(Object.keys(platformNames) as WorkerPlatform[]).map(value => <label key={value} className={platform === value ? 'selected' : undefined}>
        <input type="radio" name={`worker-platform-${id}`} value={value} checked={platform === value} onChange={() => onChange(value)} />
        {platformNames[value]}
      </label>)}
    </div>
  </div>;
}

function CommandBox({ text, label, disabled, platform, shell, wrap = false }: {
  text: string; label: string; disabled?: boolean; platform?: WorkerPlatform; shell?: string; wrap?: boolean;
}) {
  return <div className="setup-command-box">
    <div className="setup-command-toolbar">
      <span>{shell ?? (platform ? platformShell[platform] : 'Text')}</span>
      <CopyButton key={text} text={text} label={label} disabled={disabled} iconOnly />
    </div>
    <pre className={wrap ? 'oauth-code wrap' : 'oauth-code'} tabIndex={0}><code>{text}</code></pre>
  </div>;
}

type Stage = 'connect' | 'prompt' | 'worker';
const workerSteps = ['Prepare your computer', 'Install your agent and test sandbox', 'Download and start', 'Connect your token'] as const;

function ProgressRail({ stage, setStage, authorized }: {
  stage: Stage; setStage: (stage: Stage) => void; authorized: boolean;
}) {
  const items: { id: Stage; label: string; done: boolean; optional?: boolean }[] = [
    { id: 'connect', label: 'Connect agent', done: authorized },
    { id: 'prompt', label: 'Agent chat', done: false },
    { id: 'worker', label: 'Worker', done: false, optional: true },
  ];
  return <ol className="setup-rail" aria-label="Setup progress">
    {items.map((item, index) => <li key={item.id}>
      <button type="button" aria-current={stage === item.id ? 'step' : undefined} onClick={() => setStage(item.id)}
        className={`${stage === item.id ? 'current ' : ''}${item.done ? 'done' : ''}`}>
        <span className="rail-dot" aria-hidden="true">{item.done ? <Check size={14} /> : index + 1}</span>
        <span className="rail-label">{item.label}{item.optional && <small>optional</small>}</span>
        {item.done && <span className="sr-only"> (complete)</span>}
      </button>
    </li>)}
  </ol>;
}

function WorkerStatus({ agent }: { agent: Agent }) {
  // This comes from the server's latest workspace snapshot, never from the terminal.
  const when = agent.lastSeen ? (ago(agent.lastSeen) === 'Just now' ? 'just now' : ago(agent.lastSeen)) : '';
  const seen = agent.lastSeen ? `last seen ${when}` : 'not seen yet';
  return <div className="worker-status" role="status" aria-live="polite">
    <span className={`dot ${agent.presence === 'online' ? 'dot-online' : 'dot-off'}`} aria-hidden="true" />
    <div>
      <strong>{agent.presence === 'online' ? 'Online' : agent.presence === 'stale' ? 'Stale' : 'Offline'}</strong>
      <span className="muted"> · {agent.presence === 'online' ? `last check-in ${when || 'not recorded'}` : seen}</span>
      <p className="small muted">Updates about every 15 seconds. Online means {agent.name} checked in recently, including from its terminal worker.</p>
    </div>
  </div>;
}

function WorkerSetup({ project, agent, url, initialClient, roomPrompt, connectNode, authorized, startAtWorker }: {
  project: Project; agent?: Agent; url: string; initialClient: string; roomPrompt: string;
  connectNode: ReactNode; authorized: boolean; startAtWorker: boolean;
}) {
  const { user } = useSession();
  const [tab, setTab] = useState<'first' | 'reconnect'>('first');
  const [platform, setPlatformState] = useState<WorkerPlatform>(initialPlatform);
  const setPlatform = (value: WorkerPlatform) => {
    setPlatformState(value);
    try { localStorage.setItem(PLATFORM_KEY, value); } catch { /* The choice still applies for this session. */ }
  };
  const [stage, setStage] = useState<Stage>(startAtWorker ? 'worker' : authorized ? 'prompt' : 'connect');
  const [workerStep, setWorkerStep] = useState(0);
  const stageBox = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    // Move keyboard and screen-reader focus to the new step's heading, but not on first render.
    if (!mounted.current) { mounted.current = true; return; }
    stageBox.current?.closest('.dialog-body')?.scrollTo({ top: 0 });
    stageBox.current?.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true });
  }, [stage, workerStep]);
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [engine, setEngine] = useState(initialClient === 'Claude Code' ? 'claude' : initialClient === 'Codex' ? 'codex' : 'custom');
  const [custom, setCustom] = useState('');
  const [verification, setVerification] = useState('');
  const [resumeTaskId, setResumeTaskId] = useState('');
  const ownedAgents = project.agents.filter(candidate => candidate.ownerId === user?.id && candidate.grant !== 'revoked');
  const workerAgent = agent ?? ownedAgents.find(candidate => candidate.id === selectedAgentId);
  const sandboxSetup = 'npm install -g @anthropic-ai/sandbox-runtime@0.0.81';
  const codexSetup = 'npm install -g @openai/codex@latest\ncodex login\ncodex login status';
  // The native installer uses ~/.local/bin; make it available in this terminal
  // immediately so the login commands and runner can find the new executable.
  const claudeSetup = `curl -fsSL https://claude.ai/install.sh | bash\nexport PATH="$HOME/.local/bin:$PATH"\nclaude auth login\nclaude auth status`;
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const repositoryValid = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(project.repository)
    && project.repository.split('/').every(part => part !== '.' && part !== '..');
  const ready = repositoryValid && (engine !== 'custom' || !!custom.trim());
  const verificationArgs = verification.split('\n').map(line => line.trim()).filter(Boolean)
    .map(command => ` --verify-command ${quote(command)}`).join('');
  const argumentsText = `--prompt-token --project ${quote(project.id)} --url ${quote(url)} --repository ${quote(project.repository)}${workerAgent ? ` --agent-id ${quote(workerAgent.id)}` : ''} ${engine === 'custom' ? `--agent-command ${quote(custom.trim() || 'YOUR_AGENT_COMMAND')}` : `--agent ${engine}`}${verificationArgs}`;
  // The frontend serves the runner; absolute install and managed workspace paths
  // let users run this command from any terminal directory.
  const scriptUrl = new URL('/downloads/tandem_runner.py', window.location.origin).href;
  const installCommand = `mkdir -p "$HOME/Downloads" &&\ncurl -fLsS ${quote(scriptUrl)} \\\n  -o "$HOME/Downloads/tandem_runner.py" &&\npython3 "$HOME/Downloads/tandem_runner.py" ${argumentsText}`;
  const resumableTasks = workerAgent ? project.tasks.filter(task =>
    (task.agentId === workerAgent.id || task.assignedAgentId === workerAgent.id)
    && ['blocked', 'claimed', 'in_progress'].includes(task.status)) : [];
  const resumeCommand = resumeTaskId ? `${installCommand} --resume-task ${quote(resumeTaskId)}` : '';
  const branch = project.trackedBranch?.trim() || 'main';
  const workerOnline = !!workerAgent && workerAgent.presence === 'online';
  const commandPlatform = { platform };

  const platformGuide = <section aria-label="Platform instructions">
    {platform === 'macos' ? <>
      <p>Use Terminal on your Mac for the commands in this guide.</p>
      <p className="small muted">Install Python 3.11+, Node.js/npm, curl, Git and GitHub CLI before continuing.</p>
    </> : platform === 'linux'
      ? <p>Use your Linux terminal. Install Python 3.11+, Node.js/npm, curl, Git, GitHub CLI, bubblewrap and socat with your distribution’s package manager.</p>
      : <>
        <p>Use Ubuntu in WSL 2 for this worker. Native PowerShell cannot run Tandem’s verification sandbox.</p>
        <p>In PowerShell as Administrator, install WSL and Ubuntu:</p>
        <CommandBox text="wsl --install -d Ubuntu" label="Copy WSL install command" shell="Administrator PowerShell" />
        <p className="small muted">Restart if prompted, open Ubuntu, and create your Linux username. <a href="https://learn.microsoft.com/en-us/windows/wsl/install" target="_blank" rel="noreferrer">WSL installation help</a>.</p>
        <p>Run all commands that follow in the Ubuntu terminal. Install and sign in to your agent and GitHub CLI inside Ubuntu, even if they are installed on Windows. Downloads means your Linux home’s Downloads folder.</p>
      </>}
    {platform !== 'macos' && <>
      <p>Ubuntu/Debian: refresh the package list and install the worker’s system tools. Other Linux distributions use their own package manager.</p>
      <CommandBox text="sudo apt update && sudo apt install -y python3 curl git gh bubblewrap socat" label="Copy Linux prerequisites command" {...commandPlatform} />
      <p className="small muted">Also install Node.js/npm and confirm Python is version 3.11 or newer.</p>
    </>}
  </section>;

  const workerContent = <section aria-label="Continuous worker setup" className="worker-stage">
    {workerStep === 0 && <p>A <strong>worker</strong> is a small program that runs in your terminal. It picks up tasks you have approved for this agent, runs your coding agent on them, and opens pull requests for you to review. It is optional: your agent can already talk to Tandem. No access to Tandem’s private repository is needed.</p>}
    <OsPicker id="worker" platform={platform} onChange={setPlatform} />
    {workerStep === 0 && <>
      <h3 tabIndex={-1}>{workerSteps[0]}</h3>
      <details className="agent-advanced" key={platform} open={platform !== 'macos'}>
        <summary>Before you start: tools to install</summary>
        {platformGuide}
      </details>
      <p>Sign in to GitHub so the worker can access your repository and push commits:</p>
      <CommandBox text="gh auth login" label="Copy GitHub login command" {...commandPlatform} />
    </>}
    {workerStep === 1 && <>
      <h3 tabIndex={-1}>{workerSteps[1]}</h3>
      <Field label="Agent CLI the worker runs"><select value={engine} onChange={e => setEngine(e.target.value)}>
        <option value="codex">Codex CLI</option><option value="claude">Claude Code CLI</option><option value="custom">Other command</option>
      </select></Field>
      {engine === 'custom' && <Field label="Agent command"><input value={custom} onChange={e => setCustom(e.target.value)} placeholder="Your headless command" /></Field>}
      {engine === 'custom' && <p className="small muted">Accept tasks on stdin, run without prompts, and leave edits for the worker to verify and commit. Sign in before starting.</p>}
      {engine === 'codex' && <section aria-label="Codex CLI setup">
        <p>Install Codex, then sign in with your OpenAI account. Requires Node.js/npm.</p>
        <CommandBox text={codexSetup} label="Copy Codex setup commands" {...commandPlatform} />
        <details className="agent-advanced"><summary>What these commands do</summary>
          <ul className="small muted"><li><code>npm install</code> installs or updates Codex.</li><li><code>codex login</code> starts sign-in.</li><li><code>codex login status</code> confirms you are signed in.</li></ul>
        </details>
      </section>}
      {engine === 'claude' && <section aria-label="Claude CLI setup">
        <p>Install Claude Code, then sign in with your Anthropic account.</p>
        <CommandBox text={claudeSetup} label="Copy Claude setup commands" {...commandPlatform} />
        <p className="trust-note">The first line downloads and runs Anthropic’s official installer from claude.ai. Open that address to read it first if you prefer.</p>
        <details className="agent-advanced"><summary>What these commands do</summary>
          <ul className="small muted"><li><code>curl … | bash</code> downloads and runs Claude’s installer.</li><li><code>export PATH</code> makes Claude available in this terminal.</li><li><code>claude auth login</code> starts sign-in.</li><li><code>claude auth status</code> confirms you are signed in.</li></ul>
        </details>
      </section>}
      <section aria-label="Verification sandbox setup">
        <h4>Install Tandem’s shared verification utility</h4>
        <p className="small muted">Required for post-task tests with any worker. This Anthropic-maintained utility isolates test commands; it does not run Claude or require an Anthropic account. Your selected agent stays {engine === 'codex' ? 'Codex' : engine === 'claude' ? 'Claude Code' : 'unchanged'}. Requires Node.js/npm.</p>
        <CommandBox text={sandboxSetup} label="Copy sandbox setup command" {...commandPlatform} />
      </section>
      <details className="agent-advanced"><summary>Custom verification commands (optional)</summary>
        <p className="small muted">Runs root typecheck, lint, test and build scripts in an OS sandbox with an isolated environment and no network access. Other commands below replace these checks. Missing sandbox, denied access or failed checks stop the push; checks never fall back to the host.</p>
        <Field label="Verification commands"><textarea value={verification} onChange={e => setVerification(e.target.value)} placeholder="npm run test:e2e" /></Field>
      </details>
    </>}
    {workerStep === 2 && <>
      <h3 tabIndex={-1}>{workerSteps[2]}</h3>
      <section aria-label="Download and start worker">
        <p>Tandem prepares <strong>{project.repository}</strong> automatically with a separate worktree per agent. Verified commits are pushed only to <strong>{branch}</strong>, as configured in Project setup.</p>
        {!repositoryValid && <p role="alert">Set this project’s GitHub repository to owner/repository before starting a worker.</p>}
        <p>{ready ? 'Copy the command, paste it into your terminal, and press Enter. Run it in your project folder to reuse it, or anywhere to download the project automatically.' : 'Choose your agent in the previous step to enable copying.'}</p>
        {engine === 'custom' && !custom.trim() && <p className="small muted">Also enter your headless agent command in the previous step.</p>}
        <CommandBox text={installCommand} label="Copy download and start command" disabled={!ready} {...commandPlatform} />
        <p className="trust-note">This downloads Tandem’s worker script to your Downloads folder and runs it as you. It keeps its own copy of your repository under <code>~/.local/share/tandem</code>, runs your agent CLI on approved tasks, and pushes only to <code>{branch}</code>. Use it only on projects whose members you trust. <a href="/downloads/tandem_runner.py" target="_blank" rel="noreferrer">Open the script</a> to read it first.</p>
        <p>Wait until the terminal shows <code>Tandem agent token (hidden, not saved):</code>. Leave it open and continue to the next step.</p>
        <p className="small muted">Interrupted work resumes automatically when still assigned to this agent. If saved changes cannot be matched, open the <button type="button" className="text-button" onClick={() => { setTab('reconnect'); document.getElementById('setup-reconnect-tab')?.focus(); }}>Reconnecting tab</button> for manual recovery.</p>
      </section>
    </>}
    {workerStep === 3 && <>
      <h3 tabIndex={-1}>{workerSteps[3]}</h3>
      <section aria-label="Authorize your worker">
        <p>Generate a token and copy it. Return to the waiting terminal, paste the token, and press Enter. The terminal shows nothing as you paste: no letters or dots will appear, and that is expected. The worker then checks your setup and starts looking for tasks.</p>
        {workerAgent ? <>
          <p className="small muted">A new token replaces this agent’s existing token. If you already saved a valid token, use it instead.</p>
          <AgentTokenButton project={project} agent={workerAgent} buttonLabel="Generate worker token" />
        </> : <p>Generate its token here when access is authorized. Finish connecting your agent in the first step.</p>}
      </section>
      {workerAgent && <section aria-label="Worker status">
        <WorkerStatus agent={workerAgent} />
        {workerOnline && <p className="worker-done"><CircleCheck size={16} aria-hidden="true" /><span>{workerAgent.name} is checking in. <Link to={`/projects/${project.id}/workflow?stage=execute`}>Assign it a task</Link>.</span></p>}
      </section>}
    </>}
    <div className="worker-nav">
      <Button variant="outline" disabled={workerStep === 0} onClick={() => setWorkerStep(workerStep - 1)}>Back</Button>
      <span className="small muted" aria-live="polite">Worker setup · step {workerStep + 1} of {workerSteps.length}</span>
      {workerStep < workerSteps.length - 1
        ? <Button onClick={() => setWorkerStep(workerStep + 1)}>Next: {workerSteps[workerStep + 1]}</Button>
        : <span />}
    </div>
  </section>;

  const promptContent = <section aria-label="Agent startup prompt">
    {authorized && <p className="setup-success" role="status"><CircleCheck size={18} aria-hidden="true" /> Access authorized. {(agent ?? workerAgent)?.name ?? 'Your agent'} can reach {project.name}.</p>}
    <h3 tabIndex={-1}>Start your agent chat</h3>
    {!authorized && <p className="small muted">Connect your agent first, then paste this into its chat.</p>}
    <p>Paste this into your connected agent’s chat. It tells the agent how to use Tandem.</p>
    <CommandBox text={roomPrompt} label="Copy startup prompt" shell="Agent chat" wrap />
    <div className="setup-optional">
      <p className="small muted">That is all most people need. To have your agent pick up approved tasks on its own while you are away, set up a worker. It is optional and you can do it later.</p>
      <Button variant="outline" onClick={() => setStage('worker')}>Set up a worker</Button>
    </div>
  </section>;

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
    <ProgressRail stage={stage} setStage={setStage} authorized={authorized} />
    <div className="setup-stage" ref={stageBox}>
      {stage === 'worker'
        ? <section aria-label="Autonomous worker guide">{workerContent}</section>
        : <section aria-label="Normal MCP connection">{stage === 'connect' ? connectNode : promptContent}</section>}
    </div>
  </div>
  <div role="tabpanel" id="setup-reconnect-panel" aria-labelledby="setup-reconnect-tab" hidden={tab !== 'reconnect'}>
  <section aria-label="Reconnect your worker" className="oauth-step worker-reconnect">
    <h3>Restart your worker</h3>
    <OsPicker id="reconnect" platform={platform} onChange={setPlatform} />
    <p className="small muted" aria-label="Platform note">{platform === 'windows' ? 'Run these commands in your Ubuntu terminal (WSL 2).' : platform === 'macos' ? 'Run these commands in Terminal.' : 'Run these commands in your Linux terminal.'}</p>
    {!agent && <Field label="Agent to reconnect"><select value={selectedAgentId} onChange={event => {
      const selected = ownedAgents.find(candidate => candidate.id === event.target.value);
      setSelectedAgentId(event.target.value);
      setResumeTaskId('');
      if (selected) setEngine(selected.client === 'Claude Code' ? 'claude' : selected.client === 'Codex' ? 'codex' : 'custom');
    }}><option value="">Select an agent</option>{ownedAgents.map(candidate =>
      <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></Field>}
    <p>Reuse this agent’s saved token at the hidden prompt after running the restart command below, then press Enter. The worker automatically resumes its interrupted task and preserves saved edits when that task is still assigned to this agent. You do not need to reconnect MCP.</p>
    {workerAgent ? <><p>Lost the token? Generate a replacement below. The previous token will stop working.</p>
      <AgentTokenButton project={project} agent={workerAgent} buttonLabel="Generate replacement token" />
      <WorkerStatus agent={workerAgent} /></>
      : <p className="small muted">Select an agent to get its token and restart command.</p>}
    <CommandBox text={installCommand} label="Copy download and start command" disabled={!ready || !workerAgent} {...commandPlatform} />
    <p className="small muted">Downloads the latest worker script, then restarts it with your token and saved workspace.</p>
    {!ready && <p className="small muted">Complete the worker settings in First-time setup to enable copying.</p>}
    <h3>Manual recovery (if automatic resume cannot match the task)</h3>
    <p><strong>Saved changes:</strong> “Worker workspace has uncommitted changes” (or the older “Use a clean, dedicated clone” message) means the worker found saved edits. With the command above, these are in its separate agent worktree, even when your terminal is open in another folder. The latest runner shows the exact path; run <code>git status</code> in that folder to inspect it. Do not delete or reset unfinished work.</p>
    <p>Select the task that owns those edits below, then copy and run its resume command. Paste your token when prompted and press Enter; the token stays hidden. On Windows, run the command in Ubuntu / WSL 2.</p>
    {workerAgent ? <>
      <Field label="Task to resume" hint="Choose the blocked or active task that owns those saved changes.">
        <select value={resumeTaskId} onChange={event => setResumeTaskId(event.target.value)}>
          <option value="">Select a task</option>
          {resumableTasks.map(task => <option key={task.id} value={task.id}>{task.title} · {task.status}</option>)}
        </select>
      </Field>
      {resumableTasks.length === 0 && <p className="small muted">No assigned blocked or active tasks are shown. Check Workflow before changing the saved workspace.</p>}
      {resumeTaskId && <>
        <p>Run this command to continue that task and preserve its saved edits:</p>
        <CommandBox text={resumeCommand} label="Copy resume command" disabled={!ready} {...commandPlatform} />
        <p className="small muted">Starts the worker with <code>--resume-task</code> to continue the selected task’s saved work.</p>
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
  useEffect(() => {
    if (connections.data && !project.agents.some(a => a.id === connections.data)) {
      // OAuth can register a new agent while this modal is open. Refresh the
      // workspace so its token control appears here without closing the guide.
      void queries.invalidateQueries({ queryKey: ['workspace', user?.id] });
    }
  }, [connections.data, project.agents, queries, user?.id]);
  const url = discovery.data;
  const roomPrompt = `Use Tandem for project ${project.id}.
Confirm access with tandem_whoami. Fetch tandem_get_assignments and summarize ready work and blockers.
Respect workerControl from tandem_get_assignments: stop means finish current work and claim no new tasks until start. Acknowledge the control with tandem_acknowledge_worker_control only when ready or idle.
Check tandem_get_presence_requests; acknowledge returned IDs with tandem_acknowledge_presence. Repeat between tasks.
Check tandem_get_worker_room_requests between task steps. Answer mediator-relayed questions addressed to you with tandem_reply_worker_room_request, using the same request ID. Human room messages remain private.
Before claiming work, read repo instructions, git status, the approved contract and dependencies. Preserve others’ changes and report progress, questions, tests and blockers through Tandem. Retry the same write with its original operation ID.
Never approve or merge your own work, access human room messages, or duplicate a running worker’s tasks. Work on tasks when I ask you to; do not start an autonomous task loop from this prompt.`;
  const snippet = url && (client === 'Claude Code'
    ? JSON.stringify({ mcpServers: { 'tandem-oauth': { type: 'http', url } } }, null, 2)
    : `# Tandem remote MCP connection. Authentication happens in your browser.\n[mcp_servers.tandem-oauth]\nurl = ${JSON.stringify(url)}`);
  const authorized = !!connections.data;
  const connectNode = step === 1 ? <>
      <h3 tabIndex={-1}>Add Tandem to your agent</h3>
      <Field label="Your agent">
        <select value={client} onChange={(e) => setClient(e.target.value)}>
          <option>Codex</option><option>Claude Code</option><option>Other</option>
        </select>
      </Field>
      <p>Your agent talks to Tandem over MCP, the standard way coding agents use outside tools. Add this remote server in your agent’s app, CLI, or IDE, then sign in through your browser.</p>
      <div className="field">
        <label htmlFor="mcp-server-url">Server URL</label>
        <div className="url-row">
          <input id="mcp-server-url" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
          <CopyButton key={url} text={url!} label="Copy server URL" iconOnly />
        </div>
      </div>
      <details className="agent-advanced">
        <summary>How to add it in {client}</summary>
        <p>{client === 'Claude Code'
          ? 'Add this to .mcp.json in your project, keeping any existing servers. Reload Claude Code and approve the server when prompted.'
          : client === 'Codex'
            ? 'Open MCP settings in your Codex client and add a remote HTTP server named tandem-oauth. For a local Codex client, you can also add this entry to ~/.codex/config.toml and restart the session.'
            : 'Use your client’s remote MCP settings. It must support browser sign-in.'}</p>
        {client !== 'Other' && <>
          <CommandBox text={snippet!} label="Copy configuration" shell="MCP configuration" />
          <p className="small muted">Paste this into the configuration file, not the terminal. Leave authentication headers empty.</p>
        </>}
      </details>
      {url && new URL(url).protocol === 'http:' && <p className="small muted">Local setup: keep Tandem running on this computer. Use your hosted server for other machines.</p>}
      <div className="row end"><Button onClick={() => setStep(2)}>Continue</Button></div>
    </> : <>
      <h3 tabIndex={-1}>Finish in your agent</h3>
      <p>{client === 'Claude Code'
        ? 'In Claude Code, open /mcp, choose tandem-oauth, then authenticate.'
        : 'In your agent client’s MCP settings, choose tandem-oauth and start sign-in.'}</p>
      <p>In the browser, choose <strong>{project.name}</strong>{agent ? <> and <strong>{agent.name}</strong></> : ' and name your agent'}, then click <strong>Allow connection</strong>.</p>
      <p role="status" className="setup-waiting"><span className="spinner" aria-hidden="true" />Waiting for authorization…</p>
      <ErrorNotice error={connections.error} retry={() => void connections.refetch()} />
      <Button variant="outline" onClick={() => setStep(1)}>Back</Button>
    </>;
  return <Modal open onOpenChange={(open) => { if (!open) onClose(); }}
    title={agent ? 'Set up worker' : 'Connect your agent'}
    description={agent ? `${agent.name} · ${project.name}` : project.name} className="agent-setup-dialog"
    footer={<>
      <Link to="/settings/user?section=connected-agents" onClick={onClose}>Manage connections</Link>
      <Button variant="outline" onClick={() => { void queries.invalidateQueries({ queryKey: ['workspace'] }); onClose(); }}>Done</Button>
    </>}>
    {discovery.isPending && <p role="status">Checking your server…</p>}
    <ErrorNotice error={discovery.error} retry={() => void discovery.refetch()} />
    {url && <WorkerSetup key={`${agent?.id ?? String(connections.data)}:${client}`} project={project}
      agent={agent ?? project.agents.find(a => a.id === connections.data)} url={url} initialClient={client}
      roomPrompt={roomPrompt} connectNode={connectNode} authorized={authorized} startAtWorker={!!agent} />}
  </Modal>;
}
