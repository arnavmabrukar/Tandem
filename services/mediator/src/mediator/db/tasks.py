from uuid import UUID

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from mediator.config import settings
from mediator.db.projects import (
    OperationConflict,
    ProjectAccessDenied,
    ProjectVersionConflict,
)
from mediator.schemas.tasks import CreateTaskRequest, CreateTaskResponse


def create_task(
    actor_id: UUID,
    project_id: UUID,
    request: CreateTaskRequest,
) -> CreateTaskResponse:
    """Create an unassigned task with authorization and safe retries."""

    # The route must obtain actor_id from the authenticated user.
    # Never trust a user ID supplied in the request body.
    if settings.database_url is None:
        raise RuntimeError("DATABASE_URL is not configured")

    database_url = settings.database_url.get_secret_value()
    if not database_url.strip():
        raise RuntimeError("DATABASE_URL is empty")

    # Include the URL's project ID when comparing retries.
    # An operation cannot be reused for a different project.
    payload = {
        "projectId": str(project_id),
        **request.model_dump(mode="json"),
    }

    # dict_row lets us access returned columns by name.
    # The connection context commits on success and rolls back on error.
    with psycopg.connect(
        database_url,
        connect_timeout=10,
        row_factory=dict_row,
    ) as connection:
        # Each statement sees changes committed before that statement began.
        # This lets a waiting retry read the first request's saved result.
        connection.execute(
            "SET TRANSACTION ISOLATION LEVEL READ COMMITTED"
        )

        # Reserve this user's operation ID.
        # A concurrent request using the same ID waits for this transaction.
        reservation = connection.execute(
            """
            INSERT INTO public.operations (
                actor_id, operation_id, operation_type, request_payload
            )
            VALUES (%s, %s, 'create_task', %s)
            ON CONFLICT (actor_id, operation_id) DO NOTHING
            RETURNING operation_id
            """,
            (actor_id, request.operationId, Jsonb(payload)),
        ).fetchone()

        # Check current permissions for BOTH new requests and retries.
        # Owners and reviewers can create tasks under the existing API contract.
        # Lock the membership so its role cannot change during this operation.
        membership = connection.execute(
            """
            SELECT role
            FROM public.project_memberships
            WHERE project_id = %s AND user_id = %s
            FOR SHARE
            """,
            (project_id, actor_id),
        ).fetchone()

        if membership is None or membership["role"] not in (
            "owner",
            "reviewer",
        ):
            raise ProjectAccessDenied(
                "Project owner or reviewer access is required"
            )

        if reservation is None:
            # This operation already exists: inspect its original request.
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

            # Reusing an operation ID with different data is a conflict.
            if (
                existing["operation_type"] != "create_task"
                or existing["request_payload"] != payload
            ):
                raise OperationConflict(
                    "Operation ID was already used for another request"
                )

            if existing["response_payload"] is None:
                raise RuntimeError("Operation has no saved response")

            # Return the original result without inserting another task.
            # Do not recheck expectedVersion here: the original operation
            # already advanced the project's version.
            result = CreateTaskResponse.model_validate(
                existing["response_payload"]
            )

        else:
            # Check the expected version and increment it atomically.
            # Two new operations targeting the same version cannot both win.
            project = connection.execute(
                """
                UPDATE public.projects
                SET version = version + 1
                WHERE id = %s AND version = %s
                RETURNING id, version
                """,
                (project_id, request.expectedVersion),
            ).fetchone()

            if project is None:
                raise ProjectVersionConflict(
                    "Project changed; reload before creating the task"
                )

            # Create the task using server-controlled identity and defaults.
            # The database supplies status='open', version=1, and timestamps.
            # For now, use the title as the initial contract summary.
            task = connection.execute(
                """
                INSERT INTO public.tasks (
                    project_id,
                    created_by,
                    title,
                    description,
                    contract_summary,
                    contract_paths,
                    acceptance_criteria
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                RETURNING id
                """,
                (
                    project_id,
                    actor_id,
                    request.title,
                    request.description,
                    request.title,
                    request.paths,
                    request.criteria,
                ),
            ).fetchone()

            if task is None:
                raise RuntimeError("Task creation returned no row")

            # entityId is the TASK ID, while projectVersion belongs
            # to the project containing that task.
            result = CreateTaskResponse(
                projectId=project["id"],
                projectVersion=project["version"],
                entityId=task["id"],
            )

            # Save the successful response alongside the task.
            # Jsonb adapts the Python dictionary for PostgreSQL JSONB.
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

    # Return only after all changes have committed successfully.
    return result


