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
