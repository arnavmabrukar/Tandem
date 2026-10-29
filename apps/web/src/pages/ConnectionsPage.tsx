import { PageHeader } from '../components/common';
import { configuration } from '../config';

export function ConnectionsPage() {
  return (
    <>
      <PageHeader
        title="Connection guide"
        description="The frontend calls one authenticated human API. Implement its endpoints in the mediator."
      />
      <section className="panel">
        <h2>Configured services</h2>
        <dl className="details-grid">
          <dt>API origin</dt>
          <dd>
            <code>{configuration.config?.apiBaseUrl}</code>
          </dd>
          <dt>Auth0 domain</dt>
          <dd>
            <code>{configuration.config?.auth0Domain}</code>
          </dd>
        </dl>
        <p>
          Requests use an Auth0 access token. Project data is fetched from the API and kept only in
          the current in-memory query cache.
        </p>
      </section>
      <section className="panel">
        <h2>Where to implement</h2>
        <ul className="bullets">
          <li>
            <strong>Backend:</strong> implement the routes in <code>apps/web/API.md</code> under{' '}
            <code>services/mediator</code>. The backend owns persistence, membership, task
            transitions, claims, approvals and provider integrations.
          </li>
          <li>
            <strong>Frontend transport:</strong> <code>src/api/client.ts</code> already maps each
            screen action to its HTTP endpoint. Change that map only when you intentionally change
            the API contract.
          </li>
          <li>
            <strong>Response shapes:</strong> <code>src/types/domain.ts</code> validates every
            response. Match these shapes or update the contract and frontend together.
          </li>
          <li>
            <strong>Configuration:</strong> fill the four public settings from{' '}
            <code>.env.example</code>, configure Auth0 callback/logout URLs and backend CORS, then
            restart Vite.
          </li>
        </ul>
      </section>
      <section className="panel">
        <h2>Server-owned connections</h2>
        <p>
          The backend must verify Auth0 tokens and resolve current memberships. Agent OAuth/MCP,
          Meta calls, PostgreSQL, the worker and GitHub evidence stay behind the mediator. The
          browser does not contact those systems directly.
        </p>
        <p>
          Missing endpoints, rejected requests and service outages are shown as errors. There is no
          alternative local data source.
        </p>
      </section>
    </>
  );
}
