# Human dashboard API contract

**Implementation handoff:** the frontend already calls the routes below. Implement them in `services/mediator/`; this document does not imply that a server exists. There is one HTTP client at `src/api/client.ts`, and all response validation is defined in `src/types/domain.ts`. These are human-facing projections, separate from the agent MCP protocol and database models.

## Transport and identity

`VITE_API_BASE_URL` supplies an origin such as `http://localhost:8000`. The client appends `/api/...` paths. HTTPS is required for remote origins. All requests carry `Authorization: Bearer <Auth0 access token>` and `Accept: application/json`. Writes also carry `Content-Type: application/json` and `Idempotency-Key: <operationId>`. Requests do not send cookies and do not follow redirects.

Verify the Auth0 token's signature using your issuer's keys, expected issuer, audience and expiry. Resolve the internal user from the verified subject and check current membership for every operation. `/api/me` returns that internal ID, which must match `project.members[].id`. Do not use request data such as the agent's display `owner` field as authority.

Configure CORS for the actual dashboard origin, with `GET`, `POST`, `PATCH`, `OPTIONS`, and the `Authorization`, `Content-Type`, `Idempotency-Key` request headers. Preflight requests must work without a bearer token. Credentialed cookies are not used. CORS does not replace authorization.

## Read endpoints

| Method / path        | Required successful JSON                                                                |
| -------------------- | --------------------------------------------------------------------------------------- |
| `GET /api/me`        | `{ "id": "internal-user-id", "name": "Display name" }` — both strings must be nonempty. |
| `GET /api/workspace` | `{ "schemaVersion": 1, "projects": [...] }` matching `workspaceSchema`.                 |

Return only projects the caller may access. An authenticated user with no projects receives `projects: []`. Do not return an empty workspace to disguise a dependency failure or missing implementation. Return a non-2xx error instead.

The current client expects a **complete, consistent snapshot**, not a page of partial results. There are no cursor or pagination requests. Include every required collection, using empty arrays only when there are genuinely no entries. A project version and all of its collections must describe the same committed state. Before introducing pagination, update the client and contract together so truncated history is not silently presented as complete.

### Response projections

The authoritative field names, nullability and enums are the exported Zod schemas in `src/types/domain.ts`. No field listed below is optional unless explicitly indicated. IDs are strings. Version, sequence and generation fields are integers. Timestamps are ISO 8601 strings; nullable timestamps should be `null` when absent. Repositories use `owner/repository` format. Heads and merge commits identify full Git commit SHAs.

| Projection | Required fields                                                                                                                                                                                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project    | `id`, `name`, `repository`, `description`, `version`, `members[]`, `invitations[]`, `agents[]`, `tasks[]`, `approvals[]`, `messages[]`, `claims[]`, `activity[]`                                                                                                                  |
| Member     | `id`, `name`, `role`: `owner`, `reviewer`, or `viewer`                                                                                                                                                                                                                            |
| Invitation | `id`, `email`, `role`, `status`: `pending` or `revoked`                                                                                                                                                                                                                           |
| Agent      | `id`, `name`, `client`: `Codex`, `Claude Code`, or `Other`; `owner`, `machine`, `capabilities: string[]`; `grant`: `pending`, `active`, or `revoked`; `presence`: `online`, `stale`, or `offline`; `lastSeen: string \| null`, `session: string \| null`                          |
| Task       | `id`, `title`, `description`, `status`, `agentId: string \| null`, `version`, `threadId`, `receipt`: `pending` or `received`; `acceptance`: `pending`, `accepted`, or `declined`; `progress`, `dependencies: string[]`, `contract`, `result: object \| null`                      |
| Contract   | `version`, `summary`, `paths: string[]`, `criteria: string[]`, `history: string[]`                                                                                                                                                                                                |
| Result     | `head`, `branch`, `prNumber: integer`, `evidence: string[]`, `mergeCommit: string \| null`                                                                                                                                                                                        |
| Approval   | `id`, `taskId`, `action`: `Review result` or `Approve contract`; `repository`, `status`: `pending`, `approved`, `rejected`, or `stale`; `taskVersion`, `contractVersion`, `head: string \| null`, `requestedAt`, `decidedBy: string \| null`, `decidedAt: string \| null`, `note` |
| Message    | `id`, `taskId`, `sequence`, `sender`, `type`: `question`, `answer`, `status`, `result`, or `human_note`; `body`, `createdAt`, `replyTo: string \| null`, `receipt`: `pending` or `received`                                                                                       |
| Claim      | `id`, `taskId`, `agentId`, `path`, `state`: `active`, `stale`, `review_reserved`, or `released`; `generation`, `expiresAt: string \| null`                                                                                                                                        |
| Activity   | `id`, `sequence`, `taskId: string \| null`, `kind`, `actor`, `text`, `createdAt`                                                                                                                                                                                                  |

Task statuses: `open`, `claimed`, `in_progress`, `in_review`, `approved`, `merged`, `blocked`, `conflict`, `cancelled`. Return canonical server state rather than inferring completion from a posted message. Stable message sequences are ordered within each task; activity sequences are ordered within each project. Referenced IDs must belong to the same authorized project.

## Mutation endpoints

Every JSON body includes these common fields, in addition to its route-specific payload:

```json
{
  "operationId": "client-generated-uuid",
  "expectedVersion": 4
}
```

`operationId` matches the `Idempotency-Key` header. `expectedVersion` is the last loaded **project** version; it is `null` only for project creation. There is no `actorId`, command `type` or path resource ID in the JSON body. Resolve those from the token and route.

In the table, `:p`, `:i`, `:a`, `:t`, `:r` represent the project, invitation, agent, task and approval IDs. The client URL-encodes each segment.

| Method / path                                  | Additional JSON fields                                                                     | UI authority                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `POST /api/projects`                           | `name`, `repository`, `description`                                                        | Signed-in human; backend applies creation policy and grants creator membership. |
| `PATCH /api/projects/:p`                       | `name`, `repository`, `description`                                                        | Owner                                                                           |
| `POST /api/projects/:p/invitations`            | `email`, `role`                                                                            | Owner                                                                           |
| `POST /api/projects/:p/invitations/:i/revoke`  | None                                                                                       | Owner                                                                           |
| `POST /api/projects/:p/agents`                 | `name`, `client`, `owner`, `machine`, `capabilities: string[]`                             | Owner                                                                           |
| `POST /api/projects/:p/agents/:a/revoke`       | None                                                                                       | Owner                                                                           |
| `POST /api/projects/:p/tasks`                  | `title`, `description`, `agentId: string \| null`, `paths: string[]`, `criteria: string[]` | Owner or reviewer                                                               |
| `POST /api/projects/:p/tasks/:t/cancel`        | None                                                                                       | Owner or reviewer                                                               |
| `POST /api/projects/:p/tasks/:t/messages`      | `body`, `replyTo: string \| null`                                                          | Owner or reviewer                                                               |
| `POST /api/projects/:p/approvals/:r/decisions` | `decision`: `approved` or `rejected`; `note`, `target` below                               | Owner or reviewer                                                               |

All authorities must be enforced by the server, regardless of UI controls. Viewers have no mutation controls. The server also validates resource scope, role changes, field limits, lifecycle transitions and all domain-specific restrictions.

### Successful mutation response

Return HTTP 200 or 201 **after committing**, with JSON matching `mutationResultSchema`:

```json
{
  "projectId": "confirmed-project-id",
  "projectVersion": 5,
  "entityId": "created-or-affected-resource-id"
}
```

`projectId` must be nonempty. `projectVersion` is a positive integer identifying the resulting committed snapshot. `entityId` is required and nonempty for task creation, because the UI opens that task. It is optional for other commands; returning the created/affected ID consistently is recommended. Do not return 204, HTML, a job placeholder or an unconfirmed success. The frontend refetches `/api/workspace` after success; that read must observe the committed result. Do not return an entire project in place of this acknowledgement.

### Exact approval target

The decision body includes the target the human reviewed:

```json
{
  "operationId": "client-generated-uuid",
  "expectedVersion": 4,
  "decision": "approved",
  "note": "Human review explanation",
  "target": {
    "action": "Review result",
    "repository": "owner/repository",
    "taskVersion": 2,
    "contractVersion": 1,
    "head": "full-commit-sha"
  }
}
```

`head` is nullable for a request without a code target. Atomically compare the request, repository, action, task version, contract version, head and current authority against authoritative state. Reject stale or mismatched targets with 409. Record the human decision and audit entry durably. An approval does not merge code, launch an agent or rewrite a contract.

## Consistency, retries and errors

1. Authenticate and authorize each request, including replays.
2. Look up the operation ID scoped to the actor/project. If the identical operation already committed, return its original result **before** checking the old `expectedVersion`. Otherwise a retry of a successful save would incorrectly conflict with its own version increment. Reject reuse with different intent.
3. For a new operation, compare `expectedVersion` with the current project version. Return 409 on mismatch without applying the command.
4. Commit the operation outcome, domain changes, new project version, messages/jobs and audit entries atomically as appropriate. Concurrent requests with the same key must apply at most once.

The browser does not retry writes automatically. A manual retry of identical intent in the same mounted form reuses the original body and ID. If a response is lost, times out, is malformed or returns 5xx, the UI treats the outcome as unknown. Changing the form first replays the earlier request before submitting different intent. Do not expire deduplication records while such retries can still occur; define retention with the backend recovery policy.

Retry IDs and drafts are held in memory and are lost when the form unmounts or the page reloads. Users must review server state after abandoning an uncertain save. A durable recovery journal or operation lookup UI would require an additional feature; it is not implemented here.

| Status / failure                      | Client behavior / server expectation                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 400 or 422                            | Validation error; keep form values. Do not apply command.                                                            |
| 401                                   | Hide workspace and request sign-in again.                                                                            |
| 403                                   | Denied; hide project data on a denied snapshot, keep mutation unauthorized.                                          |
| 404                                   | Show missing resource/endpoint error.                                                                                |
| 409                                   | Refetch state and require review; never optimistically apply the change.                                             |
| 429                                   | Show busy message; user can retry. Do not apply the rejected command.                                                |
| 5xx, network error, 15-second timeout | Show failure; writes dispatched to the API may have committed and must be reconciled.                                |
| Invalid JSON or response schema       | Show contract error; never substitute fake or empty success data. A malformed write response has an unknown outcome. |

Error JSON is optional for this version: the UI uses safe status-specific messages rather than displaying server traces. Read failures retain an explicitly marked stale snapshot except for denied access. Queries poll every 15 seconds and may also refetch on browser focus/reconnect. There is no websocket, event stream or offline data store.

## Remaining server and agent work

Implement the API handlers and projection assembly inside `services/mediator/`, sharing domain policy with the MCP service and worker. The frontend does not connect directly to PostgreSQL, Meta, GitHub, agent OAuth, agent inboxes or local machines. Keep provider secrets and those integrations on the server.

Adding an agent submits a grant record request; the backend determines its actual grant/presence state and completes the separate agent authorization flow. It does not launch an agent. Invitations require backend identity/delivery handling. Task creation proposes assignment and scope; it does not prove acceptance or acquire file claims. Cancellation/revocation must reconcile claims explicitly. Result submission is separate from approval, and only verified GitHub merge evidence should mark a result merged.

First integrate authentication, `/api/me`, and a real empty `/api/workspace`; then project creation, tasks/messages, agent state, and approvals. Add actual tenant/backend integration tests before relying on access control or distributed coordination. Existing frontend browser tests use isolated responses under `tests/` and do not implement or certify these server behaviors.
