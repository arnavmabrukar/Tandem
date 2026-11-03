from typing import Any, Literal
from uuid import UUID

from psycopg import Connection


def record_task_activity(
    connection: Connection[dict[str, Any]],
    *,
    project_id: UUID,
    task_id: UUID,
    actor_id: UUID,
    kind: Literal["task_created", "task_cancelled", "task_assigned"],
    text: str,
) -> None:
    """Record a task event inside the caller's existing transaction."""

    # This helper must run inside a transaction so the counter and event
    # cannot commit separately. Our task functions already provide one.
    if connection.autocommit:
        raise RuntimeError("Activity recording requires a transaction")

    # Type hints help editors, but Python does not enforce them at runtime.
    if kind not in ("task_created", "task_cancelled", "task_assigned"):
        raise ValueError("Unsupported task activity kind")

    if not text.strip():
        raise ValueError("Activity text must not be blank")

    # Increment the project's event counter atomically.
    # Concurrent writers for this project wait for the row lock.
    # The caller must follow the project-before-task locking order.
    project = connection.execute(
        """
        UPDATE public.projects
        SET activity_sequence = activity_sequence + 1
        WHERE id = %s
        RETURNING activity_sequence
        """,
        (project_id,),
    ).fetchone()

    if project is None:
        raise RuntimeError("Activity project could not be found")

    # Read the actor's name from our own users table.
    # Never accept the actor's identity or display name from request JSON.
    actor = connection.execute(
        """
        SELECT name
        FROM public.users
        WHERE id = %s
        """,
        (actor_id,),
    ).fetchone()

    if actor is None:
        raise RuntimeError("Activity actor could not be found")

    # Store the current name as a historical display label.
    # The foreign keys also verify the actor exists and the task
    # belongs to the specified project.
    connection.execute(
        """
        INSERT INTO public.project_activity (
            project_id,
            sequence,
            task_id,
            actor_user_id,
            actor_name,
            kind,
            text
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        """,
        (
            project_id,
            project["activity_sequence"],
            task_id,
            actor_id,
            actor["name"],
            kind,
            text,
        ),
    )

    # No commit here.
    # The calling task function commits the task, event, counter,
    # and saved operation response together.