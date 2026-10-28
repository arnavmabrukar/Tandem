# Tandem frontend

A functional **browser-only demo** of the human dashboard. Run it to test screens and interactions while the team builds the mediator independently.

Everything is under `apps/web`. No backend, MCP server, worker, database, Auth0 integration, Meta integration, GitHub integration, deployment, or agent client configuration is implemented. There are no HTTP service calls. Demo labels remain visible throughout the app.

## Run locally

Use Node.js **22.12+** (Node 24 LTS recommended) and npm. From the repository root:

```sh
cd apps/web
npm ci
npm run dev
```

Open the printed local URL, normally `http://127.0.0.1:5173`. Select a demo persona and enter the dashboard. No environment variables, credentials, database, or running agents are needed. The dev server binds to loopback only.

```sh
npm run build          # TypeScript check and production bundle
npm run preview        # Preview dist/ at http://127.0.0.1:4173
npm run typecheck
npm run format:check   # Check source formatting (npm run format to apply)
npm test               # Demo adapter behavior tests
npx playwright install chromium
npm run test:e2e        # Desktop and mobile Chromium browser tests
```

Playwright starts its own local Vite server on port 4173. Stop an unrelated server on that port before testing. Mobile tests emulate a phone viewport in Chromium; they do not certify Safari or a physical device. `dist/`, dependencies, reports and local `.env` files are ignored.

## What works now

| Screen            | Functional frontend behavior                                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Demo sign-in      | Arnav (owner), Eashan (reviewer), and viewer personas; sign-out; return to an opened project/task link                                                      |
| Activity          | Task/review/attention counts, chronological event history, search, event filters and navigation                                                             |
| Tasks             | Search and status/agent filters in the URL, task creation, draft file scope and criteria, task detail and cancellation                                      |
| Thread detail     | Separate receipt, acceptance, progress and merge signals; dependencies; contract scope/history; file reservations; result evidence; human notes and replies |
| Human approvals   | Pending and historical reviews, exact task/contract/head targets, explicit acknowledgment, required review note, approve/reject, stale-target handling      |
| Agent connections | Simulated grant, presence, session and check-in signals; add pending records and revoke demo grants; project-wide file claims                               |
| Project setup     | Create/select projects, edit details, list human roles, create/revoke invitation records                                                                    |
| Connection guide  | In-app overview of what the team needs to connect later                                                                                                     |

Owner/reviewer/viewer controls let you exercise different UI permissions. These are **simulated personas**, not authentication or a security boundary. New projects belong to their creator; fixed sample projects are visible to all three personas. No email is sent by an invitation. Adding an agent never launches a process or grants real access. File scope on a new task does not create a claim. Approval never creates merge evidence or changes a GitHub repository.

Fixture PR numbers, hashes, test evidence, activity and presence are explicitly fictional. Do not use them as evidence about the actual repository. The six seeded tasks cover open, in-progress, review, blocked, conflict and merged displays. New tasks stay open until the team implements real agent/backend operations; demo buttons do not pretend to advance real work.

## Local data and test scenarios

- Demo state is stored under `tandem.frontend-demo.v1` in `localStorage`; it survives a page reload. The persona uses `sessionStorage`, so separate tabs can select different personas. Signing out clears query cache and session selection, but retains local demo projects.
- Each project has an independent snapshot. Switching project clears page-local drafts. Hash routes work on a static host without a history fallback rule.
- The footer's **Demo controls** can simulate slow reads/writes, offline errors, a failure before the next save, a new PR head, empty fixtures or a full reset. Reset requires confirmation and replaces only this origin's browser demo state.
- **Change review head** stales the original request and creates a new one. To test an already-open review, open two tabs at the same origin, open a review in the first, and change the head in the second. The storage event refreshes the first tab and disables its old target.
- Failed writes keep the draft. The frontend retains a logical operation ID for a retry of the same action. Mutations are not automatically retried. A conflict prompts a refresh/review, rather than claiming success.
- The adapter keeps the last 100 demo operation receipts and serializes writes between same-origin tabs with Web Locks where available. This is a test convenience, **not** a distributed lock, durable inbox, or production idempotency implementation. Storage can be edited or cleared by the browser user. No data is shared between machines or origins (including different localhost ports).
- Corrupt/incompatible saved data shows an error rather than silently deleting it. Reset sample data to recover. If browser storage is denied/full, the app reports the failure; allow storage or use another browser profile.
- Demo timestamps are fixture snapshots; the browser does not run lease expiry or heartbeat policies. The future worker and backend must supply authoritative states.

Do not put credentials or sensitive project data into this demo. No token inputs are provided.

## Code map

| File/directory              | Responsibility                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------- |
| `src/App.tsx`               | Routes, signed-in shell, snapshot loading and recoverable error states                 |
| `src/pages/`                | The screens listed above                                                               |
| `src/components/`           | Layout, exact-target review dialog, file claims, test controls and common presentation |
| `src/components/ui/`        | Small shadcn-style Button and Radix Dialog source primitives                           |
| `src/styles.css`            | Simple responsive styling; Tailwind is available for utility classes                   |
| `src/types/domain.ts`       | Typed demo projections, runtime storage schemas, commands and `DashboardApi` interface |
| `src/api/client.ts`         | Single adapter selection point; currently exports the demo adapter                     |
| `src/api/demo.ts`           | Browser-only fixture reads/writes and failure simulation; never import into the server |
| `src/api/fixtures.ts`       | Sample personas, projects, tasks, messages, claims and reviews                         |
| `src/auth/session.tsx`      | Demo persona context; replacement point for real human sessions                        |
| `src/hooks/useWorkspace.ts` | TanStack Query, project snapshots, cross-tab refresh and write lifecycle               |
| `tests/demo.test.ts`        | Demo persistence, replay, scope, stale-target, storage failure and review behavior     |
| `tests/dashboard.spec.ts`   | Real browser interaction tests on desktop/mobile layouts                               |

Stack: React, TypeScript, Vite, Tailwind CSS, locally owned shadcn-style primitives built on Radix, TanStack Query, React Router and Zod. Dependencies are pinned by `package-lock.json`. Only the small UI primitives needed here are included; there is no generated component catalog or external font/image dependency.

## Connect the real application later — team work, not implemented here

### 1. Agree the read projections and command contracts

`DashboardApi` has two methods:

```ts
load(actorId: string): Promise<Workspace>
execute(request: MutationRequest): Promise<MutationResult>
```

These are frontend adapter contracts, **not a final HTTP API**. `load` supplies consistent project snapshots; `execute` accepts one typed human intent with project scope, expected project version and operation ID. Production may fetch project summaries separately from per-project/thread snapshots and paginated event/message lists. Change the adapter and query hooks together when those projections are agreed.

The proposed mappings below describe what to implement in the backend/HTTP adapter; none of these endpoints exist in this frontend:

| UI operation             | Suggested server boundary                                              | Required result/semantics                                                                    |
| ------------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| List projects            | `GET /api/projects`                                                    | Current token's accessible projects and permissions                                          |
| Load a project           | `GET /api/projects/:projectId/snapshot`                                | Consistent revision/watermark; agents, tasks, contracts, claims and reviews                  |
| Create/edit project      | `POST /api/projects`; `PATCH /api/projects/:projectId`                 | Confirmed project ID/version, authorized owner, stable operation ID                          |
| Create/revoke invitation | `POST /api/projects/:projectId/invitations`; explicit revoke operation | Server-owned recipient/role/lifecycle and delivery status                                    |
| Add/revoke agent grant   | Project-scoped grant creation/revocation operations                    | Current human authority, stable agent identity, real grant state; no launch command          |
| Create/cancel task       | Project-scoped task creation/cancellation operations                   | Versioned intent with explicit ownership/review/claim disposition                            |
| Read thread              | `GET /api/projects/:projectId/threads/:threadId/snapshot`              | Consistent task, contract, result and ordered message context                                |
| Post human note/reply    | Project/thread-scoped message operation                                | Message ID, sequence, sender resolved from token, reply scope and actual delivery status     |
| Make review decision     | Project-scoped approval decision operation                             | Exact action, task/contract versions, repository and PR head; confirmed decision or conflict |
| Read activity            | Project-scoped activity pages with cursor/watermark                    | Server ordering, stable IDs and explicit gaps/recovery                                       |

Use the backend's final names/shapes. A human dashboard API is separate from agent MCP methods. Do not send browser calls directly to agent `register`, `poll`, `ack` or `complete` tools as a shortcut.

### 2. Replace the demo data adapter

Create a future HTTP adapter under `src/api/` and return it from `src/api/client.ts` once the backend contracts exist. Keep `demo.ts` selectable for isolated frontend tests only; do not silently fall back to it after a live service error.

Remove the demo controls and demo persona/reset hooks from the live application shell when selecting that adapter. Keep the clearly labeled demo available as a separate development mode if useful. Do not present the fixture controls as real server actions.

The adapter should validate response schemas, attach the current human access token, use bounded timeouts and map errors to actionable UI states. Do not trust `actorId`, `from`, role labels or user IDs supplied by the browser for authority: resolve identity from the verified token and current database memberships on the server. This demo passes `actorId` only to select fixture permissions.

Translate the demo's broad `expectedVersion` into the backend's actual task/contract/claim/approval versions. Reuse an operation ID across retries of identical intent. On 409/stale targets, refetch and require review of the new target. On an uncertain network outcome, query the operation result before allowing a new logical operation. Never optimistically approve or merge in a query cache. Invalidate/refetch affected snapshots only after a confirmed mutation.

Define pagination, retained history, cancellation, stale-claim reconciliation and allowed human actions with the backend team. The fixture adapter is not a specification or a replacement for domain policy.

### 3. Connect human authentication

Replace `src/auth/session.tsx` with the team's Auth0 integration. Configure a browser application, authorized callback/logout origins and the human API audience. Obtain an access token through the provider flow, keep it out of localStorage and logs, and handle loading, expiry, denied access and sign-out. Clear all identity-specific queries and drafts when sessions change.

The future public build-time variables can be `VITE_API_BASE_URL`, `VITE_AUTH0_DOMAIN`, `VITE_AUTH0_CLIENT_ID` and `VITE_AUTH0_AUDIENCE`. **They are not read by this implementation.** Supplying them alone does not connect anything. Never put database, Meta, GitHub, or Auth0 client secrets in a `VITE_*` value; Vite embeds those values into public browser files.

Backend token verification and current membership/grant checks remain mandatory for every operation. The demo's fixed role checks do not secure a deployed app.

### 4. Supply agent and coordination state from the mediator

The mediator must implement agent grants, registration, OAuth, durable messages, assignment acceptance, routing, contract amendments, file claims, task transitions, snapshots and the worker. Each owner then configures HTTPS MCP in their independent local agent client. The frontend displays confirmed server state and human decisions; it never owns an agent session or acquires a file claim on an agent's behalf.

Keep delivery receipt, task acceptance, progress, claim health, result review, human approval and verified merge as separate signals. Revocation/cancellation must not imply automatic claim release. A new head/contract must visibly invalidate old approval applicability. Use trusted GitHub evidence from the backend before displaying a real PR link, check result or merge commit.

Meta calls, PostgreSQL storage and optional GitHub checks/webhooks belong behind the backend. There is intentionally no client implementation for these services.

### 5. Wire hosting and run integration tests

`npm run build` produces static files in `apps/web/dist`. Deploy those using your chosen static host when ready. Hash routes need no server-side rewrite, and Vite's relative base supports a subdirectory. Configure allowed API origins and Auth0 redirect URLs for the actual deployment. No deployment files or workflow are added here.

Before using real data, add tests against the real backend for expired/forged tokens, project isolation, stale versions, duplicate operations, lost responses, approval applicability, server pagination/gaps, grant revocation and reconnect behavior. The included tests prove only the frontend demo behavior and rendering; they do not prove database transactions, MCP compatibility, distributed ownership or production authorization.
