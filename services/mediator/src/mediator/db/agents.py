"""Register agents without issuing credentials or activating MCP access."""

from uuid import UUID, uuid4
import hashlib
import secrets

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from mediator.config import settings
from mediator.db.projects import (
    OperationConflict,
    ProjectAccessDenied,
    ProjectVersionConflict,
)
from mediator.schemas.agents import RegisterAgentRequest, RegisterAgentResponse
from mediator.schemas.agents import IssueAgentTokenRequest, IssueAgentTokenResponse


class AgentNameConflict(Exception):
    """Another active agent in this project already uses this name."""


class AgentNotFound(Exception):
    """No agent owned by this caller has a grant in this project."""


class AgentTokenConflict(Exception):
    """A revoked agent or a completed issuance cannot issue this token."""


def register_agent(
    actor_id: UUID,
    project_id: UUID,
    request: RegisterAgentRequest,
) -> RegisterAgentResponse:
    """Save the pending agent, grant, and retry response in one transaction."""
    # actor_id must come from the authenticated user, never the request body.
    if settings.database_url is None:
        raise RuntimeError("DATABASE_URL is not configured")
    database_url = settings.database_url.get_secret_value()
    if not database_url.strip():
        raise RuntimeError("DATABASE_URL is empty")

    # Include the URL's project ID so a retry cannot target another project.
    payload = {"projectId": str(project_id), **request.model_dump(mode="json")}

    with psycopg.connect(
        database_url, connect_timeout=10, row_factory=dict_row
    ) as connection:
        connection.execute("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")

        # Concurrent requests with the same operation ID wait here.
        reservation = connection.execute(
            """INSERT INTO public.operations
                   (actor_id, operation_id, operation_type, request_payload)
               VALUES (%s, %s, 'register_agent', %s)
               ON CONFLICT (actor_id, operation_id) DO NOTHING
               RETURNING operation_id""",
            (actor_id, request.operationId, Jsonb(payload)),
        ).fetchone()

        # Check current permission on both new registrations and retries.
        # Hold the membership stable until this transaction finishes.
        membership = connection.execute(
            """SELECT role FROM public.project_memberships
               WHERE project_id = %s AND user_id = %s FOR SHARE""",
            (project_id, actor_id),
        ).fetchone()
        if membership is None or membership["role"] != "owner":
            raise ProjectAccessDenied("Project owner access is required")

        if reservation is None:
            existing = connection.execute(
                """SELECT operation_type, request_payload, response_payload
                   FROM public.operations
                   WHERE actor_id = %s AND operation_id = %s""",
                (actor_id, request.operationId),
            ).fetchone()
            if existing is None:
                raise RuntimeError("Reserved operation could not be found")
            if (
                existing["operation_type"] != "register_agent"
                or existing["request_payload"] != payload
            ):
                raise OperationConflict("Operation ID was already used for another request")
            if existing["response_payload"] is None:
                raise RuntimeError("Operation has no saved response")

            # Return the original outcome without inserting another agent or
            # checking the old version that the original request advanced.
            result = RegisterAgentResponse.model_validate(existing["response_payload"])
        else:
            # Compare and advance the project version in one atomic statement.
            project = connection.execute(
                """UPDATE public.projects SET version = version + 1
                   WHERE id = %s AND version = %s RETURNING version""",
                (project_id, request.expectedVersion),
            ).fetchone()
            if project is None:
                raise ProjectVersionConflict("Project changed; reload before registering")

            # The version update above locks the project row, so two simultaneous
            # registrations can't both pass this check. Names stay unique per project
            # because duplicates would be indistinguishable when assigning work.
            if connection.execute(
                """SELECT 1 FROM public.agent_project_grants AS project_grant
                   JOIN public.agents AS existing ON existing.id = project_grant.agent_id
                   WHERE project_grant.project_id = %s AND project_grant.status <> 'revoked'
                     AND existing.grant_status <> 'revoked'
                     AND lower(btrim(existing.name)) = lower(btrim(%s))""",
                (project_id, request.name),
            ).fetchone() is not None:
                raise AgentNameConflict("This project already has an agent with that name")

            agent_id = str(uuid4())
            # The legacy token_hash column is NOT NULL. This marker is not a
            # credential hash: no token is generated, stored, or returned yet.
            # Future authentication must reject pending agents AND this marker.
            unissued_token = f"unissued:{agent_id}"
            try:
                connection.execute(
                    """INSERT INTO public.agents
                           (id, name, client, token_hash, owner, owner_user_id,
                            machine, capabilities, grant_status, presence)
                       SELECT %s, %s, %s, %s, person.name, person.id,
                              %s, %s, 'pending', 'offline'
                       FROM public.users AS person WHERE person.id = %s""",
                    (
                        agent_id, request.name, request.client, unissued_token,
                        request.machine, request.capabilities, actor_id,
                    ),
                )
            except psycopg.errors.UniqueViolation:
                # Only reachable until migration 020 removes the old global index.
                raise AgentNameConflict("That agent name is already in use") from None

            # The owner and grant issuer are the verified caller. The submitted
            # request.owner label is never used to establish identity.
            connection.execute(
                """INSERT INTO public.agent_project_grants
                       (project_id, agent_id, owner_user_id, status, granted_by)
                   VALUES (%s, %s, %s, 'pending', %s)""",
                (project_id, agent_id, actor_id, actor_id),
            )

            result = RegisterAgentResponse(
                projectId=project_id,
                projectVersion=project["version"],
                entityId=agent_id,
            )
            # Only nonsecret metadata goes into the saved retry response.
            connection.execute(
                """UPDATE public.operations SET response_payload = %s
                   WHERE actor_id = %s AND operation_id = %s""",
                (Jsonb(result.model_dump(mode="json")), actor_id, request.operationId),
            )

    # The context manager commits before returning. Any exception rolls back
    # the agent, grant, project version bump, and operation reservation together.
    return result


def record_agent_seen(agent_id: str) -> None:
    """Record that an authenticated agent just made an MCP request."""
    if settings.database_url is None or not settings.database_url.get_secret_value().strip():
        raise RuntimeError("DATABASE_URL is not configured")
    # Check-ins must not hold up the agent's actual request for long.
    with psycopg.connect(settings.database_url.get_secret_value(), connect_timeout=3) as connection:
        # Agents can call tools rapidly, so write at most once every 30 seconds.
        connection.execute(
            """UPDATE public.agents SET last_seen_at = clock_timestamp()
               WHERE id = %s AND (last_seen_at IS NULL
                   OR last_seen_at < clock_timestamp() - interval '30 seconds')""",
            (agent_id,),
        )


def issue_agent_token(
    actor_id: UUID, project_id: UUID, agent_id: str,
    request: IssueAgentTokenRequest,
) -> IssueAgentTokenResponse:
    """Issue or replace a credential; persist only its SHA-256 hash."""
    if settings.database_url is None:
        raise RuntimeError("DATABASE_URL is not configured")
    database_url = settings.database_url.get_secret_value()
    if not database_url.strip():
        raise RuntimeError("DATABASE_URL is empty")
    payload = {"projectId": str(project_id), "agentId": agent_id,
               **request.model_dump(mode="json")}

    with psycopg.connect(database_url, connect_timeout=10, row_factory=dict_row) as connection:
        connection.execute("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
        reservation = connection.execute(
            """INSERT INTO public.operations
                   (actor_id, operation_id, operation_type, request_payload)
               VALUES (%s, %s, 'issue_agent_token', %s)
               ON CONFLICT (actor_id, operation_id) DO NOTHING RETURNING operation_id""",
            (actor_id, request.operationId, Jsonb(payload)),
        ).fetchone()
        membership = connection.execute(
            """SELECT role FROM public.project_memberships
               WHERE project_id = %s AND user_id = %s FOR SHARE""",
            (project_id, actor_id),
        ).fetchone()
        if membership is None or membership["role"] != "owner":
            raise ProjectAccessDenied("Project owner access is required")

        if reservation is None:
            existing = connection.execute(
                """SELECT operation_type, request_payload FROM public.operations
                   WHERE actor_id = %s AND operation_id = %s""",
                (actor_id, request.operationId),
            ).fetchone()
            if existing is None or existing["operation_type"] != "issue_agent_token" or existing["request_payload"] != payload:
                raise OperationConflict("Operation ID was already used for another request")
            # Retrying must not silently rotate a token that the first request
            # may already have delivered. Lost responses require explicit rotation.
            raise AgentTokenConflict("Token already issued; reload and request a replacement with a new operation ID")

        project = connection.execute(
            """UPDATE public.projects SET version = version + 1
               WHERE id = %s AND version = %s RETURNING version""",
            (project_id, request.expectedVersion),
        ).fetchone()
        if project is None:
            raise ProjectVersionConflict("Project changed; reload before issuing a token")

        # Lock both records. Even another project owner cannot obtain the
        # credential of an agent belonging to someone else.
        agent = connection.execute(
            """SELECT a.grant_status, g.status
               FROM public.agents AS a
               JOIN public.agent_project_grants AS g
                 ON g.agent_id = a.id AND g.owner_user_id = a.owner_user_id
               WHERE a.id = %s AND a.owner_user_id = %s AND g.project_id = %s
               FOR UPDATE OF a, g""",
            (agent_id, actor_id, project_id),
        ).fetchone()
        if agent is None:
            raise AgentNotFound("Agent not found")
        if agent["grant_status"] == "revoked" or agent["status"] == "revoked":
            raise AgentTokenConflict("Revoked agents cannot issue tokens")

        # 32 random bytes provide 256 bits of entropy. Unlike a human password,
        # this random secret can safely use a fast hash for lookup verification.
        token = "tdm_" + secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        connection.execute(
            """UPDATE public.agents
               SET token_hash = %s, grant_status = 'active', presence = 'offline',
                   last_seen_at = NULL, session = NULL, updated_at = clock_timestamp()
               WHERE id = %s""",
            (token_hash, agent_id),
        )
        connection.execute(
            """UPDATE public.agent_project_grants
               SET status = 'active', updated_at = clock_timestamp()
               WHERE project_id = %s AND agent_id = %s""",
            (project_id, agent_id),
        )
        result = IssueAgentTokenResponse(
            projectId=project_id, projectVersion=project["version"],
            entityId=agent_id, token=token,
        )
        # NEVER put the raw token into the operations replay table.
        connection.execute(
            """UPDATE public.operations SET response_payload = %s
               WHERE actor_id = %s AND operation_id = %s""",
            (Jsonb(result.model_dump(mode="json", exclude={"token"})), actor_id, request.operationId),
        )
    # A failed commit raises before the token can reach the caller.
    return result
