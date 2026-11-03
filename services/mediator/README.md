# Mediator: shared Neon connection

The backend has `/health` (process liveness) and `/ready` (a real PostgreSQL
`SELECT 1`). Project tables, Auth0 verification and the dashboard API remain
to be implemented. A successful readiness check does not prove those features.

Neon project: `jolly-dew-28859871`, organization `org-soft-recipe-80147539`,
branch `production` (the branch explicitly selected for this setup).
Both developers must select the same branch to share database state.
`neon deploy` configures Neon services; it does not host this FastAPI server.

## Invite your friend

In the Neon console, select the organization and open **People → Invite member**.
For a friend who should manage only Tandem, choose **Collaborator**, then grant
**Editor** access to this project after they accept. Organization-wide Editor
access is an alternative if the whole organization is shared by the team.
Use separate Neon accounts. Do not share your Neon login or commit credentials.
See https://neon.com/docs/manage/orgs-manage for current invitation/access steps.

## Set up another machine

First share these source changes through your normal Git workflow (they are not
automatically pushed by Neon). Your friend needs the updated checkout, Python
3.11+, and Node 22.12+ on a supported LTS line (Node 24 recommended).

Run from the Tandem repository root:

```sh
# Install the CLI and finish sign-in in the browser using your own account.
npm i -g neon@latest
neon login

# Install the tooling declared by neon.ts.
npm ci

# Select the existing shared project and pull its private environment variables.
neon link -y --org-id org-soft-recipe-80147539 --project-id jolly-dew-28859871 --branch production

# Create and activate this machine's Python environment (macOS/Linux).
python3 -m venv services/mediator/.venv
source services/mediator/.venv/bin/activate

# Install the backend and optional test tools.
python -m pip install -e './services/mediator[test]'

# Start the backend; open http://127.0.0.1:8000/ready to check Neon.
python -m uvicorn mediator.main:app --reload --port 8000
```

On Windows PowerShell, create the environment with `py -m venv
services/mediator/.venv` and activate with
`services\mediator\.venv\Scripts\Activate.ps1`.

The backend reads root `.env` and `.env.local` using paths relative to its source,
so running it from `services/mediator` works too. Actual environment variables
override dotenv values. `DATABASE_URL` is server-only and retains Neon's SSL
options. `DATABASE_URL_UNPOOLED` is reserved for future migrations/admin tools.
The URL is not a `VITE_*` variable and must not enter browser code.

## Verify

```sh
# From the repository root, with the Python environment activated:
python -m unittest discover -s services/mediator/tests/unit -v

# Install frontend dependencies and build the existing dashboard.
npm --prefix apps/web ci
npm run build
```

`GET /ready` returns `200` with `{"status":"ok","database":"connected"}`
only after a real query succeeds. Missing settings or database connection errors
produce `503` with a generic message. `/health` does not depend on the database.

In pgAdmin, use the direct host, role, password and database from Neon's
**Connect** dialog for the same branch, port `5432`, and SSL mode `require`.
Your local Homebrew PostgreSQL database is separate from this hosted database.
No schema or records were migrated during this setup.

## Hosted MCP OAuth

See [MCP_OAUTH.md](MCP_OAUTH.md) for migration 011, local and Render settings,
browser consent, credential lifetimes, disconnecting clients, and verification.

## Autonomous flow

1. A project owner reviews a plan and clicks **Approve and run**. That creates its tasks,
   approves their contracts with the owner's note, and turns on automatic delegation.
2. Every 15 seconds the dispatcher assigns ready tasks to online agents, picking the one
   with the fewest unfinished tasks. A task is ready once its contract is approved and its
   dependencies are `approved` or `merged`.
3. An [agent runner](../../agent-integrations/runner/README.md) claims the task, runs a
   headless coding agent, pushes a branch, opens a pull request, and moves the task to
   `in_review`. If that fails, the task moves to `blocked` and says why.
4. A person merges the pull request and clicks **Accept work**, which unlocks dependent
   tasks, or clicks **Request changes** to send a note back to the agent.

An automatic assignment that hasn't started returns to the queue after its agent has been
offline for 15 minutes. Claimed work never moves on its own, because that agent may have
work in progress: use **Release task** instead. Neither Tandem nor the agent merges
anything, and **Accept work** doesn't check that the pull request was merged.

Apply `migrations/versions/019_autonomous_flow.sql` before deploying this code.
`tests/integration/test_autonomous_flow.py` runs the whole chain with a stand-in coding
agent. Set `TANDEM_FLOW_TEST_DATABASE_URL` to a **new empty disposable database**, then run
the file directly.

## Accounts with more than one sign-in

Dashboard requests validate the JWT on every call. Successful Auth0 `/userinfo`
profiles are cached per token for at most five minutes (and never past token expiry)
in each API process, so room polling does not consume an Auth0 request each time.
Concurrent lookups for the same token share one request. A 429 starts a bounded
cooldown using Auth0's rate-limit headers; it never grants access using a stale
profile. Names and verified-email changes can take up to five minutes to refresh.
Project roles and memberships are still checked in the database on every request.

Apply `migrations/versions/021_account_identities.sql` **before** deploying this code. It
only adds to the schema and makes three foreign keys deferrable, so earlier code keeps
working.

Auth0 gives a password sign-in and a Google sign-in different subjects, so
`public.user_identities` maps each one to a Tandem user. At sign-in, identities with the
same **verified** email become one user. If both already hold data, they are merged into
the older account in one transaction, recorded in `public.user_merges`, and the higher
role wins in a shared project. A merge that fails rolls back, logs the two user IDs and
leaves the accounts separate, without blocking sign-in. It retries at the next sign-in.

An unverified email never joins anything, because anyone can register an address they
don't control. So the Auth0 tenant must send verification emails for password sign-ups, or
those accounts will stay separate. Accounts from before this migration have no stored
email, so duplicates merge once each sign-in has logged in again.

`tests/integration/test_account_linking.py` covers this. Set
`TANDEM_ACCOUNTS_TEST_DATABASE_URL` to a **new empty disposable database**, then run the
file directly.

## Agent tools and presence

Apply `migrations/versions/012_agent_task_actions.sql` **before** deploying this code:
the dashboard query reads its new columns. The migration only adds to the schema, so
already-running code keeps working once it has been applied.

| Tool | Purpose |
| --- | --- |
| `tandem_status` | Check that the server responds |
| `tandem_whoami` | Show the agent's identity and project grants |
| `tandem_list_tasks` | List a project's tasks and whether each can be claimed |
| `tandem_get_task` | Read a task's contract, dependencies, and thread |
| `tandem_claim_task` | Claim an open task for this agent |
| `tandem_update_task` | Report status or progress on a task this agent claimed |
| `tandem_post_message` | Post a question, answer, status, or result to a thread |

**Permissions.** Every call rechecks the agent's grants and its owner's current role.
OAuth connections reach only their consented project. Writing requires the owner to be a
project owner or reviewer. Agents cannot approve, merge, or cancel tasks, or decide reviews.

**Claiming** requires an `open` task, a human-approved review of its current contract, and
dependencies that are `approved` or `merged`. Refusals and `claimBlockers` give the reason.

**Writes** take an `expectedVersion` (the task's version, for claims and updates) and an
`operationId`, so a retry cannot apply twice. They also bump the project version, so a
dashboard form holding an older version is asked to reload.

**Presence** comes from the latest authenticated MCP request: online under 2 minutes, stale
under 15, then offline. It shows recent activity rather than a live connection, because
clients only contact the server when they use a tool.

`tests/integration/test_agent_tools.py` runs all migrations and the real MCP transport
against PostgreSQL. Set `TANDEM_AGENT_TOOLS_TEST_DATABASE_URL` to a **new empty disposable
database** (the test refuses one with existing tables), then run the file directly.
