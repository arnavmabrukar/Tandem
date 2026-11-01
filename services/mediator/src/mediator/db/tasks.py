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
# Request validation and response models live in the schemas module.
from mediator.schemas.tasks import (
    CreateTaskRequest,
    CreateTaskResponse,
    CancelTaskRequest,
    CancelTaskResponse,
)

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



class TaskNotFound(Exception):
    """The task does not exist in the requested project."""


class TaskStateConflict(Exception):
    """The task's current state does not allow this action."""

def cancel_task(
    actor_id: UUID,
    project_id: UUID,
    task_id: UUID,
    request: CancelTaskRequest,
) -> CancelTaskResponse:
    """Cancel an open task and save its response in one transaction."""

    if settings.database_url is None:
        raise RuntimeError("DATABASE_URL is not configured")

    database_url = settings.database_url.get_secret_value()
    if not database_url.strip():
        raise RuntimeError("DATABASE_URL is empty")

    # Include both URL identifiers when comparing retries.
    payload = {
        "projectId": str(project_id),
        "taskId": str(task_id),
        **request.model_dump(mode="json"),
    }

    with psycopg.connect(
        database_url,
        connect_timeout=10,
        row_factory=dict_row,
    ) as connection:
        connection.execute(
            "SET TRANSACTION ISOLATION LEVEL READ COMMITTED"
        )

        # Reserve the operation before modifying project or task state.
        # Concurrent requests with the same operation ID wait here.
        reservation = connection.execute(
            """
            INSERT INTO public.operations (
                actor_id, operation_id, operation_type, request_payload
            )
            VALUES (%s, %s, 'cancel_task', %s)
            ON CONFLICT (actor_id, operation_id) DO NOTHING
            RETURNING operation_id
            """,
            (actor_id, request.operationId, Jsonb(payload)),
        ).fetchone()

        # Require current permission, even when replaying a saved response.
        # Hold the membership stable until this transaction finishes.
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
            # A previous request used this operation ID.
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

            # Only an identical request can reuse the saved result.
            if (
                existing["operation_type"] != "cancel_task"
                or existing["request_payload"] != payload
            ):
                raise OperationConflict(
                    "Operation ID was already used for another request"
                )

            if existing["response_payload"] is None:
                raise RuntimeError("Operation has no saved response")

            # Do not cancel again or increment versions again.
            result = CancelTaskResponse.model_validate(
                existing["response_payload"]
            )

        else:
            # Check and advance the project version atomically.
            # This also locks the project before we lock its task.
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
                    "Project changed; reload before cancelling the task"
                )

            # Scope the lookup to the authorized project.
            # Lock the row so another transaction cannot change its status
            # between our check and the UPDATE below.
            task = connection.execute(
                """
                SELECT id, status
                FROM public.tasks
                WHERE id = %s AND project_id = %s
                FOR UPDATE
                """,
                (task_id, project_id),
            ).fetchone()

            if task is None:
                raise TaskNotFound("Task not found in this project")

            # The current implementation supports cancelling open tasks only.
            # Active agent work will need additional coordination later.
            if task["status"] != "open":
                raise TaskStateConflict(
                    "Only open tasks can currently be cancelled"
                )

            # Preserve the task and its contract.
            # Increment the task version and record its modification time.
            connection.execute(
                """
                UPDATE public.tasks
                SET status = 'cancelled',
                    version = version + 1,
                    updated_at = clock_timestamp()
                WHERE id = %s AND project_id = %s
                """,
                (task_id, project_id),
            )

            result = CancelTaskResponse(
                projectId=project["id"],
                projectVersion=project["version"],
                entityId=task_id,
            )

            # Save the response in the same transaction as the cancellation.
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

    # Successful exit commits everything before returning.
    # Any exception inside the block rolls back every change.
    return result