import { PageHeader } from '../components/common';

const integrations = [
  [
    'Human API',
    'Replace dashboardApi in src/api/client.ts with an adapter implementing DashboardApi. Map load and execute to agreed project-scoped FastAPI endpoints. The current shapes are frontend demo contracts, not final wire schemas.',
  ],
  [
    'Human sign-in',
    'Replace src/auth/session.tsx with Auth0 session handling. Acquire a human API access token in memory, clear cached data on sign-out, and use backend-returned memberships and permissions. Never put a client secret in the browser.',
  ],
  [
    'Agent connections',
    'The backend must provision grants, validate agent OAuth, and expose registration, session and presence projections. Each human then configures HTTPS MCP on their own agent client. The dashboard never launches the agent.',
  ],
  [
    'Tasks, contracts and claims',
    'The backend owns routing, transitions, versioned contracts and file reservations. Replace fixture projections with consistent server snapshots. Every write needs an operation ID and expected versions; refresh on conflict instead of guessing success.',
  ],
  [
    'Approvals and GitHub',
    'Submit the named action, task/contract versions and immutable PR head to a human-only backend approval endpoint. Verify GitHub evidence on the server. Optional checks and branch protection are separate work; humans perform merges.',
  ],
  [
    'Activity and recovery',
    'Use TanStack Query for project-scoped polling. Replace the demo snapshot with a server revision/watermark and pagination. Handle expired sessions, forbidden scope, stale versions, missing pages and uncertain write outcomes explicitly.',
  ],
  [
    'Invitations and roles',
    'Create server-owned membership and invitation endpoints before enabling real invitations. The server sends email or issues an invite link and enforces role changes. The browser only renders the confirmed outcome.',
  ],
  [
    'Hosting',
    'Build the frontend with npm run build. Serve apps/web/dist as static files. Hash-based routes avoid history rewrite rules. Set up the backend, allowed origins and Auth0 callback URLs separately; this frontend does not provision them.',
  ],
];
export function ConnectionsPage() {
  return (
    <>
      <PageHeader
        title="Connection guide"
        description="What the team needs to connect after testing the frontend."
      />
      <section className="panel">
        <h2>One replaceable data boundary</h2>
        <p>
          The UI uses <code>DashboardApi</code> from <code>src/types/domain.ts</code>. The only
          implementation today is <code>src/api/demo.ts</code>, a browser-local test double. It
          makes no service calls.
        </p>
        <pre className="code-block">{`Pages → TanStack Query → DashboardApi\n                          └─ demo adapter → localStorage\n\nLater, implemented by the team:\nDashboardApi → HTTP adapter → FastAPI → PostgreSQL`}</pre>
        <p>
          Detailed connection steps, proposed endpoint mappings and validation requirements are in{' '}
          <code>apps/web/README.md</code> in the repository.
        </p>
      </section>
      <div className="two-column">
        {integrations.map(([title, text]) => (
          <section className="panel" key={title}>
            <h2>{title}</h2>
            <p>{text}</p>
          </section>
        ))}
      </div>
      <div className="notice">
        <div>
          <strong>Configuration alone will not connect this demo.</strong>
          <p>
            There is intentionally no API URL input or pretend “Connect” button. Implement the HTTP
            and session adapters after agreeing the backend contracts. Meta keys, database
            credentials, GitHub keys and Auth0 secrets belong on the server.
          </p>
        </div>
      </div>
    </>
  );
}
