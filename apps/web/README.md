# Tandem frontend

This dashboard uses **only the real mediator API**. Project setup, agent grants, tasks, messages and human decisions submit authenticated HTTP requests. Reads show validated backend snapshots. There is no demo switch, seeded workspace, localStorage database, persona selector, or simulated success path.

The frontend is implemented. The mediator API, database, worker, MCP endpoints and external provider services are **not implemented**. Their connection points are specified in [API.md](API.md).

## Run locally

Use Node.js 22.12+:

```sh
cd apps/web
npm ci
```

Copy `.env.example` to `.env.local`. Supply these public settings:

```dotenv
VITE_API_BASE_URL=http://localhost:8000
VITE_AUTH0_DOMAIN=your-tenant.auth0.com
VITE_AUTH0_CLIENT_ID=your-spa-client-id
VITE_AUTH0_AUDIENCE=your-api-identifier
```

Then run `npm run dev` and open `http://127.0.0.1:5173/`. Restart Vite whenever settings change. The API setting must be an origin, without `/api` or another path. HTTPS is required outside localhost/loopback. These settings are embedded in public browser files; no client secret, database credential, Meta key or GitHub token belongs here.

In Auth0, configure a Single Page Application and the human API audience. For this local URL, use `http://127.0.0.1:5173/` as an allowed callback and logout URL, and `http://127.0.0.1:5173` as an allowed web origin. Use corresponding URLs for your actual hosted frontend. Callback URLs must omit hash routes. See [Auth0's React setup](https://auth0.com/docs/quickstart/spa/react).

Without the four settings, the app displays **Connect your backend**. With settings, it uses Auth0 sign-in, then requests `/api/me` and `/api/workspace`. An unavailable or unfinished backend produces a visible error; it never creates substitute records. A successful empty workspace displays project creation.

## Where to implement connections

| Location                                | Responsibility                                                                                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/mediator/` at repository root | Implement the human HTTP API in [API.md](API.md), token verification, current permissions, domain policy and persistence.                                      |
| `src/api/client.ts`                     | The only browser data client; explicit URL mappings, access tokens, timeouts, validation and errors. Change this if you deliberately change the HTTP contract. |
| `src/types/domain.ts`                   | Exact response schemas and UI command types. Backend responses must match these projections.                                                                   |
| `src/auth/session.tsx`                  | Auth0 browser flow and `/api/me` session query. Already wired; configure your tenant/application.                                                              |
| `src/config.ts` and `.env.local`        | Validate and supply the four connection settings.                                                                                                              |
| `src/hooks/useWorkspace.ts`             | Workspace polling, confirmed writes, invalidation, conflict handling and operation IDs.                                                                        |
| `src/pages/`                            | Activity, tasks, task threads, approvals, agents, project setup and connection guide.                                                                          |

You do not need to replace a demo adapter or reconnect each page. Build the server endpoints and set the environment variables. If your server contract changes, update the shared client/schema boundary and its tests together.

## Behavior

- Auth0 redirects for sign-in and sign-out. Access tokens use the SDK's in-memory cache and are attached as bearer tokens. The backend identifies the user; browser-supplied actor IDs are not used.
- The workspace is fetched after sign-in and every 15 seconds. A failed refresh explicitly labels the last successful snapshot as stale. Authorization failures hide project data.
- Writes wait for a validated server response and then refresh. There are no optimistic approvals, merges, tasks or messages.
- Failed form submissions retain the draft. Retrying identical intent reuses the operation ID while that component remains mounted. If a write outcome is unknown, changing the input first replays the earlier operation to reconcile it. The server must implement the idempotency behavior in API.md.
- Drafts, query caches and retry IDs are not durable across navigation/reload. After abandoning an uncertain save, inspect server state before starting a replacement operation.
- Project roles control the UI. The backend must independently enforce all permissions. Agent presence, delivery, acceptance, claims, results and merge evidence come from the server.

## Checks

```sh
npm run check
npx playwright install chromium
npm run test:e2e
npm run format:check
```

Unit tests cover configuration and the HTTP contract. Browser tests exercise the real application client against intercepted API responses, using a test-only identity provider substitute. All test records and substitutes live under `tests/`; normal `npm run dev` and `npm run build` do not load them. No test/demo runtime mode exists in the application.

These checks do not prove a live Auth0 tenant, server permissions, database transactions or agent interoperability. Once those services exist, test sign-in, project isolation, stale decisions, duplicate writes, interrupted responses, revocation and both independent agent clients against the actual backend.

## Build

`npm run build` creates static files in `dist/`. Supply the four settings at build time, then host those files using your chosen static host. Hash routes and Vite's relative base support subdirectories. Configure Auth0 URLs and API CORS for the deployed origin. No hosting service or deployment workflow is created here.
