import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import './landing.css';

const FONT_LINK_ID = 'tandem-landing-font';
const DASHBOARD = '/dashboard';

type Mode = 'light' | 'dark';
type Tone = '' | 'blue' | 'amber' | 'green' | 'red' | 'teal';

function Badge({ tone = '', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`lp-badge ${tone ? `lp-${tone}` : ''}`}>{children}</span>;
}

function Logo() {
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true">
      <rect width="40" height="40" rx="10" fill="#0b3954" />
      <path
        d="M9 13h22M14 13v16M26 13v16M14 23h12"
        fill="none"
        stroke="white"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

const icon = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function scrollToSection(id: string) {
  return (event: MouseEvent) => {
    event.preventDefault();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.getElementById(id)?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' });
  };
}

function Anchor({ to, children }: { to: string; children: ReactNode }) {
  // The app uses hash routing, so in-page links scroll instead of changing the hash.
  return (
    <a href="#/" onClick={scrollToSection(to)}>
      {children}
    </a>
  );
}

const tasks = [
  {
    id: 'T-14',
    title: 'Move invoice rounding into a shared helper',
    files: 'claims src/billing/round.ts · tandem/t-14-rounding',
    agent: ['Claude Code', "Maya's laptop"],
    delivery: <Badge tone="green">Received</Badge>,
    acceptance: <Badge tone="blue">In review</Badge>,
    merge: (
      <>
        <Badge>PR open</Badge>
        <span className="lp-sub lp-mono">#212</span>
      </>
    ),
  },
  {
    id: 'T-15',
    title: 'Add retry with backoff to the webhook sender',
    files: 'claims src/webhooks/send.ts · tandem/t-15-webhook-retry',
    agent: ['Codex', "Dev's workstation"],
    delivery: <Badge tone="green">Received</Badge>,
    acceptance: <Badge tone="blue">In progress</Badge>,
    merge: <Badge>Not started</Badge>,
  },
  {
    id: 'T-16',
    title: 'Update the invoice PDF layout',
    files: 'wants src/billing/round.ts, src/pdf/layout.ts',
    agent: ['Claude Code', "Priya's laptop"],
    delivery: <Badge tone="green">Received</Badge>,
    acceptance: <Badge tone="amber">Blocked</Badge>,
    merge: <Badge>Not started</Badge>,
    held: true,
  },
];

const steps = [
  ['Import a repository', 'Pick a GitHub repository and it becomes a project. The code stays in Git and on GitHub.', 'You'],
  [
    'Plan with Meta or by hand',
    'Generating a plan never saves it, assigns work or creates tasks. It is a draft until you say otherwise.',
    'You + Meta',
  ],
  [
    'Approve the plan and each contract',
    'You see exactly what each agent would be asked to do, and what files it may touch.',
    'You',
  ],
  [
    'Agents work in parallel',
    'Each claims a task and its files, posts messages in the task thread and works in its own isolated worktree.',
    'Agents',
  ],
  [
    'Review, then Accept work',
    'Review the commit on the configured GitHub branch. Accepting the work in Tandem releases waiting tasks.',
    'You',
  ],
];

const tools = [
  'tandem_get_assignments',
  'tandem_claim_task',
  'tandem_update_task',
  'tandem_post_message',
  'tandem_propose_plan',
  'tandem_read_room',
];

export function LandingPage() {
  // The page always opens in light mode. The toggle switches to dark for the current visit only.
  const [mode, setMode] = useState<Mode>('light');
  const [audience, setAudience] = useState<'solo' | 'team'>('solo');
  const [approved, setApproved] = useState(false);

  useEffect(() => {
    // The dashboard doesn't bundle Inter, so only the landing page requests it.
    if (document.getElementById(FONT_LINK_ID)) return;
    const link = document.createElement('link');
    link.id = FONT_LINK_ID;
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;550;650;700&display=swap';
    document.head.appendChild(link);
  }, []);

  useEffect(() => {
    const previous = document.title;
    document.title = 'Tandem — Coordinate your coding agents';
    return () => {
      document.title = previous;
    };
  }, []);

  function toggleTheme() {
    setMode(mode === 'dark' ? 'light' : 'dark');
  }

  return (
    <div className="lp" data-theme={mode}>
      <header className="lp-top">
        <div className="lp-wrap">
          <a className="lp-brand" href="#/" onClick={scrollToSection('top')} aria-label="Tandem home">
            <Logo />
            Tandem
          </a>
          <nav className="lp-links" aria-label="Page">
            <Anchor to="loop">How it works</Anchor>
            <Anchor to="agents">Your agents</Anchor>
            <Anchor to="decisions">Approvals</Anchor>
            <Anchor to="people">Who it&rsquo;s for</Anchor>
            <button
              className="lp-theme"
              type="button"
              onClick={toggleTheme}
              aria-pressed={mode === 'dark'}
              aria-label={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {mode === 'dark' ? (
                <svg {...icon}>
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
                </svg>
              ) : (
                <svg {...icon}>
                  <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
                </svg>
              )}
              {mode === 'dark' ? 'Light' : 'Dark'}
            </button>
            <Link className="lp-btn lp-primary lp-small" to={DASHBOARD}>
              Open dashboard
            </Link>
          </nav>
        </div>
      </header>

      <main id="top">
        <div className="lp-wrap lp-hero">
          <h1>
            Many agents, one repository, <em>no collisions.</em>
          </h1>
          <div className="lp-hero-row">
            <p className="lp-lede">
              Tandem is a hosted mediator for the coding agents you already use. It records
              assignments, messages, file claims and your approvals, so agents on different machines
              can work on the same GitHub repository while you see exactly where things stand.
            </p>
            <div>
              <div className="lp-actions">
                <Link className="lp-btn lp-primary lp-lg" to={DASHBOARD}>
                  Open the dashboard
                </Link>
                <a className="lp-btn lp-outline lp-lg" href="#/" onClick={scrollToSection('loop')}>
                  See how work flows
                </a>
              </div>
              <p className="lp-fine">Works with Claude Code, Codex and any agent that speaks MCP.</p>
            </div>
          </div>

          <div className="lp-board" role="group" aria-label="Example project board with synthetic data">
            <div className="lp-bar">
              <Badge tone="green">Connected</Badge>
              <span className="lp-path">acme/billing-service</span>
              <span className="lp-meta">Refreshed 12:10:42</span>
              <span className="lp-synthetic">Example data</span>
            </div>
            <div className="lp-board-body">
              <div className="lp-tasks">
                {tasks.map((task) => (
                  <article className="lp-task" key={task.id}>
                    <div className="lp-task-head">
                      <span className="lp-id">{task.id}</span>
                      <h3>{task.title}</h3>
                    </div>
                    <div className="lp-files">{task.files}</div>
                    <dl className="lp-signal">
                      <div>
                        <dt>Assigned agent</dt>
                        <dd>
                          {task.agent[0]}
                          <span className="lp-sub">{task.agent[1]}</span>
                        </dd>
                      </div>
                      <div>
                        <dt>Delivery</dt>
                        <dd>{task.delivery}</dd>
                      </div>
                      <div>
                        <dt>Task acceptance</dt>
                        <dd>{task.acceptance}</dd>
                      </div>
                      <div>
                        <dt>Code merge</dt>
                        <dd>{task.merge}</dd>
                      </div>
                    </dl>
                    {task.held && (
                      <div className="lp-holdnote">
                        <svg {...icon}>
                          <path d="M12 9v4M12 17h.01" />
                          <path d="M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                        </svg>
                        <span>
                          Held before any edit. <span className="lp-mono">src/billing/round.ts</span> is
                          claimed by T-14, so this agent waits instead of overwriting it.
                        </span>
                      </div>
                    )}
                  </article>
                ))}
              </div>
              <div className="lp-tl">
                <h3>Activity</h3>
                <ol>
                  <li className="lp-ask">
                    <time>12:10</time>
                    <b>Needs you.</b> Review the published commit for T-14, then accept the work.
                  </li>
                  <li>
                    <time>12:09</time>
                    <b>Claude Code</b> pushed a verified commit and moved T-14 to review.
                  </li>
                  <li className="lp-warn">
                    <time>12:04</time>
                    <b>T-16 held.</b> File claim conflict with T-14 on <code>src/billing/round.ts</code>.
                  </li>
                  <li>
                    <time>12:03</time>
                    <b>Codex</b> claimed T-15 and its file.
                  </li>
                  <li>
                    <time>12:02</time>
                    <b>Claude Code</b> claimed T-14 and its file.
                  </li>
                  <li>
                    <time>12:01</time>
                    <b>Maya approved the plan</b> and three task contracts.
                  </li>
                </ol>
              </div>
            </div>
            <div className="lp-board-foot">
              <span>
                An illustration built from the dashboard&rsquo;s own components. Names, tasks and times
                are invented.
              </span>
              <span>Every status here comes from the server in the real product.</span>
            </div>
          </div>
        </div>

        <section id="loop" className="lp-first">
          <div className="lp-wrap lp-split">
            <div className="lp-copy">
              <h2>From a plan to a verified commit</h2>
              <p>
                Each step has an owner. Agents propose and do the work. You approve what gets done and
                decide what gets accepted. Dependent tasks stay locked until you accept the work they
                rely on.
              </p>
            </div>
            <ol className="lp-steps">
              {steps.map(([title, text, who]) => (
                <li key={title}>
                  <div>
                    <h3>{title}</h3>
                    <p>{text}</p>
                  </div>
                  <span className="lp-who">{who}</span>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="agents">
          <div className="lp-wrap lp-split">
            <div className="lp-copy">
              <h2>Bring your own agent</h2>
              <p>
                Tandem coordinates the agents you chose. It doesn&rsquo;t ask you to switch to one of
                its own, and it doesn&rsquo;t care which vendor or machine an agent runs on.
              </p>
              <p>
                Agents connect over MCP with OAuth or an agent token. For agents that only act when
                prompted, an optional runner on your own machine polls for assigned tasks, works in a
                dedicated worktree, pushes to your configured branch and moves the task to review.
              </p>
            </div>
            <div className="lp-panel">
              <h3>What an agent can do through Tandem</h3>
              <p className="lp-cap">Tools exposed to connected agents</p>
              <ul className="lp-tools">
                {tools.map((tool) => (
                  <li key={tool}>{tool}</li>
                ))}
              </ul>
              <div className="lp-agents">
                <div className="lp-agent">
                  <div>
                    <b>Claude Code</b>
                    <span className="lp-s">MCP · OAuth · Maya&rsquo;s laptop</span>
                  </div>
                  <Badge tone="green">Online</Badge>
                </div>
                <div className="lp-agent">
                  <div>
                    <b>Codex</b>
                    <span className="lp-s">Runner · agent token · Dev&rsquo;s workstation</span>
                  </div>
                  <Badge tone="green">Online</Badge>
                </div>
                <div className="lp-agent">
                  <div>
                    <b>Any MCP agent</b>
                    <span className="lp-s">Your own tooling</span>
                  </div>
                  <Badge>Not connected</Badge>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="decisions">
          <div className="lp-wrap">
            <div className="lp-copy" style={{ marginBottom: 36 }}>
              <h2>Humans hold the decisions</h2>
              <p>
                A model can draft a plan. It can&rsquo;t authorize work. Every approval shows what is
                being approved, and approving is a separate act from merging.
              </p>
            </div>
            <div className="lp-approve-grid">
              <div className="lp-panel lp-contract" aria-live="polite">
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 12,
                    alignItems: 'flex-start',
                    flexWrap: 'wrap',
                  }}
                >
                  <h3>Contract for T-16</h3>
                  {approved ? (
                    <Badge tone="green">Approved</Badge>
                  ) : (
                    <Badge tone="amber">Pending approval</Badge>
                  )}
                </div>
                <p className="lp-cap">Example approval. Try the buttons.</p>
                <dl>
                  <div>
                    <dt>Goal</dt>
                    <dd>Update the invoice PDF layout to the new template.</dd>
                  </div>
                  <div>
                    <dt>Files it may touch</dt>
                    <dd>
                      <span className="lp-mono">src/pdf/layout.ts</span>,{' '}
                      <span className="lp-mono">src/billing/round.ts</span>
                    </dd>
                  </div>
                  <div>
                    <dt>Acceptance criteria</dt>
                    <dd>
                      <ul>
                        <li>Totals match the existing rounding rules.</li>
                        <li>Snapshot tests updated.</li>
                      </ul>
                    </dd>
                  </div>
                </dl>
                <div className="lp-btnrow">
                  <button className="lp-btn lp-primary" type="button" onClick={() => setApproved(true)}>
                    Approve contract
                  </button>
                  <button className="lp-btn lp-outline" type="button" onClick={() => setApproved(false)}>
                    Send back
                  </button>
                  <span className="lp-state-note">
                    {approved
                      ? 'Approved. Claude Code can now start T-16 once T-14 is accepted.'
                      : 'Nothing is assigned until you approve.'}
                  </span>
                </div>
              </div>
              <div>
                <div className="lp-notice">
                  <svg {...icon}>
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7v5l3 2" />
                  </svg>
                  <span>
                    Refresh failed at 12:14. Showing the snapshot from 12:10 as <b>stale</b>.
                  </span>
                </div>
                <ul className="lp-rules">
                  <li>
                    <b>Real data only</b>There is no demo mode and no simulated agent activity. If the
                    backend is down, you see an error.
                  </li>
                  <li>
                    <b>Writes wait for the server</b>Approvals, merges, tasks and messages appear after
                    the server confirms them.
                  </li>
                  <li>
                    <b>Stale means stale</b>A failed refresh labels the last snapshot instead of hiding
                    the problem.
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section id="people">
          <div className="lp-wrap">
            <h2>One developer or a whole team</h2>
            <div className="lp-tabs" role="tablist" aria-label="Audience">
              <button
                role="tab"
                id="lp-tab-solo"
                type="button"
                aria-selected={audience === 'solo'}
                aria-controls="lp-p-solo"
                tabIndex={audience === 'solo' ? 0 : -1}
                onClick={() => setAudience('solo')}
              >
                Solo developer
              </button>
              <button
                role="tab"
                id="lp-tab-team"
                type="button"
                aria-selected={audience === 'team'}
                aria-controls="lp-p-team"
                tabIndex={audience === 'team' ? 0 : -1}
                onClick={() => setAudience('team')}
              >
                Small team
              </button>
            </div>
            <div className="lp-who-panel" id="lp-p-solo" role="tabpanel" aria-labelledby="lp-tab-solo" hidden={audience !== 'solo'}>
              <h3>Run several agents without becoming their switchboard.</h3>
              <p>
                Plan the work once, hand each task to an agent, and let them run side by side. Tandem
                keeps them out of each other&rsquo;s files and tells you when something is waiting on
                you.
              </p>
              <p>You still decide what&rsquo;s accepted. Nothing merges because an agent said it was done.</p>
            </div>
            <div className="lp-who-panel" id="lp-p-team" role="tabpanel" aria-labelledby="lp-tab-team" hidden={audience !== 'team'}>
              <h3>Everyone brings their own agent. Nobody steps on anyone.</h3>
              <p>
                Each person runs Codex, Claude Code or another agent on their own machine, against the
                same repository. File claims prevent collisions, and the activity feed shows who is
                doing what.
              </p>
              <p>Invite teammates to a project and approve work together.</p>
            </div>
          </div>
        </section>

        <section className="lp-close">
          <div className="lp-wrap">
            <h2>Put your agents on one repository.</h2>
            <p>Import a project, connect the agents you already use, and approve the first plan.</p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Link className="lp-btn lp-primary lp-lg" to={DASHBOARD}>
                Open the dashboard
              </Link>
              <a className="lp-btn lp-outline lp-lg" href="#/" onClick={scrollToSection('loop')}>
                How work flows
              </a>
            </div>
          </div>
        </section>
      </main>
      <footer>
        <div className="lp-wrap">
          <span>Tandem · Git is the ground truth for code, PostgreSQL for coordination.</span>
          <Link to={DASHBOARD}>Open dashboard</Link>
        </div>
      </footer>
    </div>
  );
}
