"""Human decisions on agent work. These are what let dependent tasks start."""
from typing import Callable
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from mediator.db import agent_tasks
from mediator.db.activity import record_task_activity
from mediator.db.projects import OperationConflict, ProjectAccessDenied, ProjectVersionConflict
from mediator.schemas.task_review import (
    ReleaseTaskRequest,
    ReviewTaskRequest,
    TaskDecisionResponse,
)

REVIEW_ROLES = ("owner", "reviewer")

# A person can return any held or stuck work to the queue.
RELEASABLE_STATUSES = ("claimed", "in_progress", "in_review", "blocked", "conflict")


def _run_decision(actor_id: UUID, project_id: UUID, task_id: UUID, operation_type: str,
                  request: ReviewTaskRequest | ReleaseTaskRequest,
                  apply: Callable[..., str]) -> TaskDecisionResponse:
    """Apply one decision atomically, replaying the saved result on an exact retry."""
    payload = {"projectId": str(project_id), "taskId": str(task_id),
               **request.model_dump(mode="json")}
    with agent_tasks._transaction() as connection:
        reserved = connection.execute(
            """INSERT INTO public.operations
                   (actor_id, operation_id, operation_type, request_payload)
               VALUES (%s, %s, %s, %s)
               ON CONFLICT (actor_id, operation_id) DO NOTHING RETURNING operation_id""",
            (actor_id, request.operationId, operation_type, Jsonb(payload)),
        ).fetchone()
        # Check current permission on retries too: access may have been removed.
        member = connection.execute(
            """SELECT role FROM public.project_memberships
               WHERE project_id = %s AND user_id = %s FOR SHARE""",
            (project_id, actor_id),
        ).fetchone()
        if member is None or member["role"] not in REVIEW_ROLES:
            raise ProjectAccessDenied("Project owner or reviewer access is required")
        if reserved is None:
            previous = connection.execute(
                """SELECT operation_type, request_payload, response_payload
                   FROM public.operations WHERE actor_id = %s AND operation_id = %s""",
                (actor_id, request.operationId),
            ).fetchone()
            if (previous is None or previous["operation_type"] != operation_type
                    or previous["request_payload"] != payload):
                raise OperationConflict("Operation ID was already used for another request")
            if previous["response_payload"] is None:
                raise RuntimeError("Operation has no saved response")
            return TaskDecisionResponse.model_validate(previous["response_payload"])

        # Lock the project before the task, matching every other task writer.
        project = connection.execute(
            """UPDATE public.projects SET version = version + 1
               WHERE id = %s AND version = %s RETURNING version""",
            (project_id, request.expectedVersion),
        ).fetchone()
        if project is None:
            raise ProjectVersionConflict("Project changed; reload before deciding")
        task = agent_tasks._lock_task(connection, project_id, task_id)
        status = apply(connection, task)
        updated = connection.execute(
            "SELECT version FROM public.tasks WHERE project_id = %s AND id = %s",
            (project_id, task_id),
        ).fetchone()
        result = TaskDecisionResponse(projectId=project_id, projectVersion=project["version"],
                                      entityId=task_id, taskVersion=updated["version"], status=status)
        connection.execute(
            """UPDATE public.operations SET response_payload = %s
               WHERE actor_id = %s AND operation_id = %s""",
            (Jsonb(result.model_dump(mode="json")), actor_id, request.operationId),
        )
    return result


def _post_note(connection, actor_id: UUID, project_id: UUID, task_id: UUID, note: str) -> None:
    """Put a reviewer's note in the task thread, where the agent will read it."""
    task = connection.execute(
        """UPDATE public.tasks SET message_sequence = message_sequence + 1
           WHERE project_id = %s AND id = %s RETURNING message_sequence""",
        (project_id, task_id),
    ).fetchone()
    actor = connection.execute("SELECT name FROM public.users WHERE id = %s", (actor_id,)).fetchone()
    connection.execute(
        """INSERT INTO public.messages
               (id, sender_user_id, sender_agent_id, sender_name, project_id, task_id,
                sequence, body, type, reply_to_message_id, created_at)
           VALUES (%s, %s, NULL, %s, %s, %s, %s, %s, 'human_note', NULL, clock_timestamp())""",
        (str(uuid4()), actor_id, actor["name"], project_id, task_id, task["message_sequence"], note),
    )


def review_task(actor_id: UUID, project_id: UUID, task_id: UUID,
                request: ReviewTaskRequest) -> TaskDecisionResponse:
    """Accept finished work, or send it back to the agent holding the claim."""
    accepting = request.decision == "accept"

    def apply(connection, task: dict) -> str:
        allowed = ("in_review",) if accepting else ("in_review", "blocked")
        if task["status"] not in allowed:
            raise agent_tasks.AgentTaskConflict(
                f"A task that is {task['status']} cannot be "
                f"{'accepted' if accepting else 'sent back'}"
            )
        if task["claimed_by_agent_id"] is None:
            raise agent_tasks.AgentTaskConflict("No agent holds this task")
        status = "approved" if accepting else "in_progress"
        connection.execute(
            """UPDATE public.tasks SET status = %s, version = version + 1,
                   updated_at = clock_timestamp()
               WHERE project_id = %s AND id = %s""",
            (status, project_id, task_id),
        )
        if request.note is not None:
            _post_note(connection, actor_id, project_id, task_id, request.note)
        record_task_activity(
            connection, project_id=project_id, task_id=task_id, actor_id=actor_id,
            kind="task_accepted" if accepting else "task_changes_requested",
            text=f"{'Accepted work on' if accepting else 'Requested changes on'}: {task['title']}",
        )
        return status

    return _run_decision(actor_id, project_id, task_id, "review_task", request, apply)


def release_task(actor_id: UUID, project_id: UUID, task_id: UUID,
                 request: ReleaseTaskRequest) -> TaskDecisionResponse:
    """Return a task to the queue, whichever agent held it."""
    def apply(connection, task: dict) -> str:
        held = task["status"] in RELEASABLE_STATUSES
        assigned_only = task["status"] == "open" and task["assigned_agent_id"] is not None
        if not held and not assigned_only:
            raise agent_tasks.AgentTaskConflict(f"A task that is {task['status']} has nothing to release")
        # A contract stays approved: the agreed work has not changed, only who does it.
        connection.execute(
            """UPDATE public.tasks
               SET status = 'open', claimed_by_agent_id = NULL, claimed_at = NULL,
                   assigned_agent_id = NULL, auto_assigned = false,
                   version = version + 1, updated_at = clock_timestamp()
               WHERE project_id = %s AND id = %s""",
            (project_id, task_id),
        )
        if request.note is not None:
            _post_note(connection, actor_id, project_id, task_id, request.note)
        record_task_activity(connection, project_id=project_id, task_id=task_id, actor_id=actor_id,
                             kind="task_released", text=f"Returned to the queue: {task['title']}")
        return "open"

    return _run_decision(actor_id, project_id, task_id, "release_task", request, apply)
