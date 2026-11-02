from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from mediator.config import settings
from mediator.db.projects import (
    OperationConflict,
    ProjectAccessDenied,
    ProjectVersionConflict,
)
from mediator.db.tasks import TaskNotFound
from mediator.schemas.messages import (
    CreateMessageRequest,
    CreateMessageResponse,
)


class InvalidReplyTarget(Exception):
    """The reply target does not exist in this task thread."""


def create_message(
    actor_id: UUID,
    project_id: UUID,
    task_id: UUID,
    request: CreateMessageRequest,
) -> CreateMessageResponse:
    """Save a human note with permission, version, and retry checks."""

    if settings.database_url is None:
        raise RuntimeError("DATABASE_URL is not configured")

    database_url = settings.database_url.get_secret_value()
    if not database_url.strip():
        raise RuntimeError("DATABASE_URL is empty")

    # Include the URL identifiers when comparing retries.
    # The same operation cannot be reused for a different thread.
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

        # Reserve the operation ID before changing anything.
        # A concurrent request using the same ID waits here.
        reservation = connection.execute(
            """
            INSERT INTO public.operations (
                actor_id, operation_id, operation_type, request_payload
            )
            VALUES (%s, %s, 'create_message', %s)
            ON CONFLICT (actor_id, operation_id) DO NOTHING
            RETURNING operation_id
            """,
            (actor_id, request.operationId, Jsonb(payload)),
        ).fetchone()

        # Check current permissions for both new operations and retries.
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
            # Return the original result only for an identical request.
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

            if (
                existing["operation_type"] != "create_message"
                or existing["request_payload"] != payload
            ):
                raise OperationConflict(
                    "Operation ID was already used for another request"
                )

            if existing["response_payload"] is None:
                raise RuntimeError("Operation has no saved response")

            # Replaying does not insert another message or advance counters.
            result = CreateMessageResponse.model_validate(
                existing["response_payload"]
            )

        else:
            # Check the version and lock the project before touching its task.
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
                    "Project changed; reload before posting the message"
                )

            # Allocate the next sequence number within this task.
            # This UPDATE locks the task row until the transaction finishes.
            # Posting a note does not change the task's work status,
            # contract version, or task version.
            task = connection.execute(
                """
                UPDATE public.tasks
                SET message_sequence = message_sequence + 1
                WHERE id = %s AND project_id = %s
                RETURNING id, message_sequence
                """,
                (task_id, project_id),
            ).fetchone()

            if task is None:
                raise TaskNotFound("Task not found in this project")

            # A reply must reference a message from the same project AND task.
            if request.replyTo is not None:
                parent = connection.execute(
                    """
                    SELECT id
                    FROM public.messages
                    WHERE id = %s
                      AND project_id = %s
                      AND task_id = %s
                    FOR KEY SHARE
                    """,
                    (request.replyTo, project_id, task_id),
                ).fetchone()

                if parent is None:
                    raise InvalidReplyTarget(
                        "Reply target must belong to this task"
                    )

            # Read the display name from our own user record.
            # actor_id must come from authentication, not request JSON.
            actor = connection.execute(
                """
                SELECT name
                FROM public.users
                WHERE id = %s
                """,
                (actor_id,),
            ).fetchone()

            if actor is None:
                raise RuntimeError("Message actor could not be found")

            # Generate a UUID, stored as TEXT to match the existing table.
            message_id = str(uuid4())

            connection.execute(
                """
                INSERT INTO public.messages (
                    id,
                    sender_user_id,
                    sender_agent_id,
                    sender_name,
                    project_id,
                    task_id,
                    sequence,
                    body,
                    type,
                    reply_to_message_id,
                    created_at
                )
                VALUES (
                    %s, %s, NULL, %s, %s, %s, %s,
                    %s, 'human_note', %s, clock_timestamp()
                )
                """,
                (
                    message_id,
                    actor_id,
                    actor["name"],
                    project_id,
                    task_id,
                    task["message_sequence"],
                    request.body,
                    request.replyTo,
                ),
            )

            result = CreateMessageResponse(
                projectId=project["id"],
                projectVersion=project["version"],
                entityId=message_id,
            )

            # Save the response atomically with the message and counters.
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

    # The connection context commits before this return.
    # Exceptions roll back the message, counters, and operation reservation.
    return result