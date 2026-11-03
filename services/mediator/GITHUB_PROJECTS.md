# GitHub repository import

Projects are created by selecting a repository accessible to both the signed-in
GitHub user and the Tandem GitHub App installation. The backend independently
checks repository identity, installation access and branch existence. GitHub
credentials remain encrypted in the backend database.

## Deployment setup

1. Apply `migrations/versions/018_github_projects.sql` to the Neon branch used by
   the backend's `DATABASE_URL`, before deploying this code. Existing projects
   remain accessible; they can be disconnected without a GitHub connection.
2. In GitHub Settings → Developer settings → GitHub Apps, create a GitHub App.
   Use your dashboard URL as its homepage. Request **Contents: Read-only**;
   Metadata read access is included. No write permissions are needed. Disable
   webhooks for this implementation. Enable user authorization and retain
   expiring user access tokens. Choose the installation scope needed by your team.
3. Set the user authorization callback URL to:
   `https://tandem-jr3e.onrender.com/api/github/callback`.
4. Generate a client secret and record the App's client ID and URL slug.
   This integration uses user authorization; it does not require an App private key.
5. Generate a token encryption key once using the mediator virtual environment:

   ```sh
   # Generate a Fernet key for backend-only encryption of GitHub user tokens.
   services/mediator/.venv/bin/python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'
   ```

6. Add these to **Render's backend environment**, then deploy/restart:

   ```dotenv
   # GitHub App credentials. Never put these in VITE_* variables.
   TANDEM_GITHUB_CLIENT_ID=your_github_app_client_id
   TANDEM_GITHUB_CLIENT_SECRET=your_github_app_client_secret
   TANDEM_GITHUB_APP_SLUG=your-github-app-url-slug
   # Keep this key stable; changing it requires users to reconnect GitHub.
   TANDEM_GITHUB_TOKEN_KEY=your_generated_fernet_key
   # Exact origins, without a trailing slash or path.
   TANDEM_GITHUB_CALLBACK_ORIGIN=https://tandem-jr3e.onrender.com
   TANDEM_GITHUB_DASHBOARD_ORIGIN=https://agentictandem.vercel.app
   ```

No new Vercel environment variables are required. The existing frontend API base
URL must point to this backend. For local development use a separate development
GitHub App with callback `http://127.0.0.1:8000/api/github/callback`, backend origin
`http://127.0.0.1:8000` and dashboard origin `http://127.0.0.1:5173`. Put backend
credentials in the root `.env.local`, never `apps/web/.env.local` or Git.

## User flow

Choose Create project → Connect GitHub → authorize Tandem. Install the GitHub App
on the desired account and selected repositories using the picker’s installation
link, then refresh. Choose an account, repository and branch, then Create project.
The default branch is prefilled. Lists are paginated; filtering searches the current
page. Archived/disabled repositories are not offered.

Authorization uses one-time, user-bound state and PKCE. Expired/revoked GitHub
access requires reconnecting. Automatic refresh-token rotation is not implemented.
The selected branch is stored and verified on import; webhook-driven GitHub change
tracking is not part of this change.

## Disconnect behavior

An owner opens Project setup, types the repository name and chooses Disconnect
repository. This archives the Tandem project and removes it from active workspaces.
It disables automatic delegation, revokes pending invitations and removes all
memberships, project agent grants and their MCP OAuth sessions. An access snapshot
and coordination history remain in the database. Already-running IDE work continues.
The GitHub repository, branches, pull requests and App installation are untouched.

Reimporting creates a new project. Restoring archived projects is not yet exposed
in the UI. A repository already imported by the same creator cannot be imported
again until disconnected. Other users can independently import repositories they
can access; joining an existing project continues to use invitations.

## Verification

Automated tests cover state/PKCE, repository/installation validation, encrypted
credential reads, duplicate import/retry behavior, ownership and version checks,
archival preservation, membership rejection after disconnect, and OAuth-session
revocation. GitHub API calls are mocked in automated tests.

After configuring the real App, verify with a test repository: import it, confirm
its branch, try a duplicate import, disconnect it, and confirm it disappears from
Tandem while GitHub remains unchanged. Test using a second member/IDE to confirm
revoked project access. Live GitHub authorization requires these external setup steps.

Reference: [GitHub App user access tokens and PKCE](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app).
