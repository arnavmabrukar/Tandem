"""Authenticate Tandem-issued agent tokens on the hosted MCP transport."""
import hashlib
import re

import psycopg
from psycopg.rows import dict_row
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.authentication import AuthCredentials
from mcp.server.auth.middleware.auth_context import AuthContextMiddleware
from mcp.server.auth.middleware.bearer_auth import AuthenticatedUser
from mcp.server.auth.provider import AccessToken

from mediator.config import settings


def verify_agent_token(token: str) -> dict | None:
    # Reject legacy markers, human Auth0 tokens, and malformed input early.
    if re.fullmatch(r"tdm_[A-Za-z0-9_-]{43}", token) is None:
        return None
    if settings.database_url is None or not settings.database_url.get_secret_value().strip():
        raise RuntimeError("Agent database is not configured")
    digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
    with psycopg.connect(settings.database_url.get_secret_value(),
                         connect_timeout=10, row_factory=dict_row) as connection:
        # Check live grants and membership on EVERY request: no token cache.
        # A token alone never creates membership or restores revoked access.
        rows = connection.execute(
            """SELECT a.id, a.name, a.client, a.owner_user_id::text AS owner_id,
                      g.project_id::text AS project_id, p.name AS project_name,
                      membership.role
               FROM public.agents AS a
               JOIN public.agent_project_grants AS g
                 ON g.agent_id = a.id AND g.owner_user_id = a.owner_user_id
               JOIN public.project_memberships AS membership
                 ON membership.project_id = g.project_id
                AND membership.user_id = a.owner_user_id
               JOIN public.projects AS p ON p.id = g.project_id
               WHERE a.token_hash = %s AND a.grant_status = 'active'
                 AND g.status = 'active'
               ORDER BY g.project_id""",
            (digest,),
        ).fetchall()
    if not rows:
        return None
    first = rows[0]
    return {
        "agentId": first["id"], "name": first["name"], "client": first["client"],
        "ownerId": first["owner_id"],
        "projects": [{"projectId": row["project_id"], "name": row["project_name"],
                      "ownerRole": row["role"]} for row in rows],
    }


class AgentBearerMiddleware:
    """Require a fixed bearer credential; this is not an OAuth login flow."""
    def __init__(self, app):
        # Use the SDK's own request identity context for tools and sessions.
        self.app = AuthContextMiddleware(app)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        header = Request(scope).headers.get("authorization", "")
        scheme, _, token = header.partition(" ")
        try:
            # Synchronous psycopg must not block the ASGI event loop.
            identity = await run_in_threadpool(verify_agent_token, token) if scheme.lower() == "bearer" else None
        except (psycopg.Error, RuntimeError):
            await JSONResponse({"detail": "Agent authentication unavailable"}, status_code=503,
                               headers={"Cache-Control": "no-store"})(scope, receive, send)
            return
        if identity is None:
            await JSONResponse({"detail": "Valid agent token required"}, status_code=401,
                               headers={"WWW-Authenticate": "Bearer", "Cache-Control": "no-store"})(scope, receive, send)
            return
        scope["user"] = AuthenticatedUser(AccessToken(
            token=token, client_id=identity["agentId"], subject=identity["ownerId"],
            scopes=[], claims={"tandem_identity": identity},
        ))
        scope["auth"] = AuthCredentials()
        await self.app(scope, receive, send)
