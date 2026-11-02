# MCP browser sign-in

Tandem acts as the OAuth authorization server for its hosted MCP endpoint. The existing
Auth0 SPA login identifies the human on Tandem's consent page. Auth0 tokens are **never**
forwarded to an IDE: the IDE receives separate, opaque Tandem OAuth credentials.

Users add the remote `/mcp/` URL in their MCP client and select its authenticate/sign-in
action. Their browser opens Tandem, they sign in with Auth0, select an existing owned
agent/project, and explicitly allow or deny the connection. An agent record must exist
first (Agents → Add agent record). Consent currently requires project owner membership,
matching manual token issuance. Connecting does not start an agent or implement new tools.

## Enable locally

1. Apply `migrations/versions/011_create_mcp_oauth.sql` to the **development** branch used by
   the backend. Migration 010 and its prerequisites must already exist.
2. Add these settings to the root `.env.local` (the backend file):

   ```dotenv
   # Enable OAuth after migration 011 has been applied.
   TANDEM_MCP_OAUTH_ENABLED=true
   # Public backend origin; discovery URLs come from this trusted setting, never Host headers.
   TANDEM_MCP_OAUTH_ISSUER=http://127.0.0.1:8000
   # Frontend origin hosting the consent page and existing Auth0 login.
   TANDEM_MCP_OAUTH_DASHBOARD=http://127.0.0.1:5173
   ```

3. Keep `apps/web/.env.local`'s `VITE_API_BASE_URL` pointing to this same backend.
4. Restart the backend and Vite. Keep the current Auth0 SPA callback/web-origin settings
   for `http://127.0.0.1:5173`. No new Auth0 client secret or Auth0 application is needed.
5. Add `http://127.0.0.1:8000/mcp/` as a **remote HTTP** MCP server in the IDE. Remove any
   manually configured Authorization header for that entry so the client can run OAuth.
   The old local stdio entry does not use browser OAuth.
6. Authenticate, approve an owned agent/project, then call `tandem_whoami` from the IDE.
   It should show exactly the project selected during consent.

## Enable on Render/Vercel

Deploy the backend and frontend changes, apply 011 to the database used by Render, then
set these **Render backend** environment variables and restart/redeploy:

```dotenv
TANDEM_MCP_OAUTH_ENABLED=true
TANDEM_MCP_OAUTH_ISSUER=https://tandem-jr3e.onrender.com
TANDEM_MCP_OAUTH_DASHBOARD=https://agentictandem.vercel.app
```

The Vercel app must use that backend as `VITE_API_BASE_URL`. Its origin must remain in
backend CORS and the existing Auth0 SPA allowed callback/web-origin settings. The IDE
callback is registered with **Tandem**, not added to the Auth0 SPA allowlist.

Use `https://tandem-jr3e.onrender.com/mcp/` including its trailing slash. This exact URL is
also the OAuth `resource` value. OAuth is disabled by default so deployment before the
migration does not break existing manually issued `tdm_` credentials.

## Protocol and permission boundaries

- RFC 9728 discovery: `/.well-known/oauth-protected-resource/mcp/` and the 401 challenge.
- RFC 8414 discovery: `/.well-known/oauth-authorization-server`.
- `/register`: dynamic registration for public clients (`token_endpoint_auth_method: none`).
  HTTPS and HTTP loopback callbacks only. Registration does not authorize a project.
- `/authorize`: authorization-code flow with S256 PKCE, exact registered redirects,
  required resource binding, and `tandem:agent` scope.
- Consent tickets last 10 minutes and bind to the first authenticated human opening them.
  The consent API requires that human's Auth0 bearer token, explicit consent, and live
  ownership. There is no automatic approval based on an existing Auth0 session.
- Codes last 2 minutes and are atomically consumed. The SDK checks the redirect, client
  and PKCE verifier; the adapter additionally checks the token request's resource.
- Access tokens last one hour; connections last 30 days. Refresh tokens rotate, and reuse
  of a consumed refresh token revokes the entire connection. Clients should serialize refresh.
- Hashes only are stored for tickets, codes, access tokens and refresh tokens.
- Every MCP request checks the session, agent grant, project grant and current membership.
  OAuth credentials authorize only the consented project, not every grant on that agent.
- `/revoke` supports public clients. Agents → Manage OAuth connections also disconnects
  owned sessions. Disconnecting OAuth does not rotate an independently issued manual token.
- Only `tandem_status` and `tandem_whoami` exist today. Future tools must enforce permissions
  using the request's `tandem_identity`; OAuth never authorizes human approval actions.
- Anonymous registration/authorization endpoints are capped at 60 requests/minute each
  per worker, and OAuth POST bodies at 16 KiB. Use an edge/global rate limit when scaling.
- This implementation uses DCR for IDE compatibility; it does not fetch arbitrary client
  metadata documents (CIMD) or implement confidential-client registration.

Expired rows should be cleaned periodically. Preserve used refresh-token hashes for the
full connection lifetime so replay detection still works. A maintenance job can delete
expired requests/codes, then expired sessions (cascading their tokens), and clients older
than 90 days with no remaining requests or sessions. Do not log token request bodies,
consent responses, or credentials.

## Verification

`npm run build` checks frontend types and builds production assets.

`services/mediator/.venv/bin/python -m unittest discover -s services/mediator/tests/unit -q`
runs existing unit tests.

`tests/integration/test_mcp_oauth.py` runs real HTTP handlers and real PostgreSQL transactions.
Set `TANDEM_OAUTH_TEST_DATABASE_URL` to a **new empty disposable database**, then run:

```sh
# This test refuses an existing application database and creates its own fixtures.
services/mediator/.venv/bin/python services/mediator/tests/integration/test_mcp_oauth.py -q
```

Auth0 identity is stubbed in that integration suite. Finish deployment verification in a
real browser and both IDE clients: authenticate, call whoami, deny consent, disconnect,
and confirm subsequent calls fail or request reauthentication. Browser/IDE and hosted
verification are separate from the automated tests.

Protocol reference: https://modelcontextprotocol.io/specification/latest/basic/authorization
