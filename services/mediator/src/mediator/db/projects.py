from uuid import UUID

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from mediator.config import settings
from mediator.schemas.projects import (
    CreateProjectRequest,
    CreateProjectResponse,
)


class OperationConflict(Exception):
    """An operation ID was reused with different request data."""


class ProjectAccessDenied(Exception):
    """The caller no longer has permission to replay this operation."""


def create_project(
    actor_id: UUID,
    request: CreateProjectRequest,
) -> CreateProjectResponse:
    """Save a project, its owner membership, and its operation atomically."""

    # actor_id must come from the authenticated user's database record.
    # Never take it from the request body.
    if settings.database_url is None:
        raise RuntimeError("DATABASE_URL is not configured")

    database_url = settings.database_url.get_secret_value()
    if not database_url.strip():
        raise RuntimeError("DATABASE_URL is empty")

    # Convert UUID values into JSON-compatible strings.
    # Store the full validated request so retries can be compared.
    payload = request.model_dump(mode="json")

    with psycopg.connect(
        database_url,
        connect_timeout=10,
        row_factory=dict_row,
    ) as connection:
        # Each statement can see transactions committed before it starts.
        # This matters when simultaneous requests share an operation ID.
        connection.execute(
            "SET TRANSACTION ISOLATION LEVEL READ COMMITTED"
        )

        # Reserve this user's operation ID before creating anything.
        # A concurrent request with the same key waits for this
        # transaction to commit or roll back.
        reservation = connection.execute(
            """
            INSERT INTO public.operations (
                actor_id,
                operation_id,
                operation_type,
                request_payload
            )
            VALUES (%s, %s, 'create_project', %s)
            ON CONFLICT (actor_id, operation_id) DO NOTHING
            RETURNING operation_id
            """,
            (actor_id, request.operationId, Jsonb(payload)),
        ).fetchone()

        if reservation is None:
            # The operation already exists. Read its saved outcome.
            existing = connection.execute(
                """
                SELECT operation_type, request_payload, response_payload
                FROM public.operations
                WHERE actor_id = %s AND operation_id = %s
                """,
                (actor_id, request.operationId),
            ).fetchone()

            if existing is None:
                raise RuntimeError("Reserved operation could not be found")

            # The same operation ID cannot represent a different action.
            if (
                existing["operation_type"] != "create_project"
                or existing["request_payload"] != payload
            ):
                raise OperationConflict(
                    "Operation ID was already used for another request"
                )

            # A successful transaction must have saved its response.
            if existing["response_payload"] is None:
                raise RuntimeError("Operation has no saved response")

            result = CreateProjectResponse.model_validate(
                existing["response_payload"]
            )

            # Recheck authorization even when returning a saved result.
            # Lock the membership against changes until this read finishes.
            membership = connection.execute(
                """
                SELECT role
                FROM public.project_memberships
                WHERE project_id = %s AND user_id = %s
                FOR SHARE
                """,
                (result.projectId, actor_id),
            ).fetchone()

            if membership is None or membership["role"] != "owner":
                raise ProjectAccessDenied(
                    "Project owner access is required"
                )

        else:
            # This is a new operation. Create the project.
            project = connection.execute(
                """
                INSERT INTO public.projects (
                    name, repository, description
                )
                VALUES (%s, %s, %s)
                RETURNING id, version
                """,
                (
                    request.name,
                    request.repository,
                    request.description,
                ),
            ).fetchone()

            if project is None:
                raise RuntimeError("Project creation returned no row")

            # Make the authenticated creator the project's owner.
            connection.execute(
                """
                INSERT INTO public.project_memberships (
                    project_id, user_id, role
                )
                VALUES (%s, %s, 'owner')
                """,
                (project["id"], actor_id),
            )

            # Validate the response before saving or committing it.
            result = CreateProjectResponse(
                projectId=project["id"],
                projectVersion=project["version"],
                entityId=project["id"],
            )

            # Save the exact successful result for future retries.
            connection.execute(
                """
                UPDATE public.operations
                SET response_payload = %s
                WHERE actor_id = %s AND operation_id = %s
                """,
                (
                    Jsonb(result.model_dump(mode="json")),
                    actor_id,
                    request.operationId,
                ),
            )

    # Leaving the with-block commits before we return.
    # Any exception inside it rolls back all of the writes.
    return result