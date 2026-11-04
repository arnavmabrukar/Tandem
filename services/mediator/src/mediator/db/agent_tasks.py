"""Project reads and task actions for authenticated MCP agents.

`identity` always comes from the authenticated request, never from tool input.
Each transaction re-checks the grant and the owner's current membership, so an
agent can never do more than its owner is currently allowed to do.
"""
from contextlib import contextmanager
from datetime import datetime
from typing import Any, Callable
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from mediator.config import settings

# Matches the roles allowed to change tasks and post notes over the human API.
WRITE_ROLES = ("owner", "reviewer")

# A prerequisite counts as finished once its work has been accepted.
FINISHED_STATUSES = ("approved", "merged")

# Status changes an agent may make to a task it has claimed. Tasks that a human
# has moved elsewhere, such as 'approved', are deliberately absent.
AGENT_TRANSITIONS: dict[str, tuple[str, ...]] = {
    "claimed": ("in_progress", "blocked"),
    "in_progress": ("in_review", "blocked"),
    "in_review": ("in_progress", "blocked"),
    "blocked": ("in_progress",),
}

MESSAGE_LIMIT = 200
TASK_LIMIT = 200

_TASK_SELECT = """
    SELECT t.id::text AS id, t.title, t.description, t.status, t.version,
           t.progress, t.contract_version, t.contract_summary, t.contract_paths,
           t.acceptance_criteria, t.assigned_agent_id, t.claimed_by_agent_id, t.claimed_at, t.updated_at,
           -- Only a review of the CURRENT contract can authorize work on it.
           (SELECT approval.status FROM public.contract_approvals AS approval
            WHERE approval.project_id = t.project_id AND approval.task_id = t.id
              AND approval.contract_version = t.contract_version
            ORDER BY approval.requested_at DESC, approval.id DESC
            LIMIT 1) AS contract_review,
           (SELECT COALESCE(jsonb_agg(
                       jsonb_build_object('id', prerequisite.id::text,
                                          'title', prerequisite.title,
                                          'status', prerequisite.status)
                       ORDER BY prerequisite.created_at, prerequisite.id),
                   '[]'::jsonb)
            FROM public.task_dependencies AS dependency
            JOIN public.tasks AS prerequisite
              ON prerequisite.project_id = dependency.project_id
             AND prerequisite.id = dependency.depends_on_task_id
            WHERE dependency.project_id = t.project_id
              AND dependency.task_id = t.id) AS dependencies
    FROM public.tasks AS t
"""


class AgentToolError(Exception):
    """A refusal whose message is safe to show to the calling agent."""


class AgentAccessDenied(AgentToolError):
    """The agent's grant or its owner's role does not allow this action."""


class AgentTaskNotFound(AgentToolError):
    """The task or reply target is not in this project."""


class AgentTaskConflict(AgentToolError):
    """The task changed, or its state does not allow this action."""


class AgentClaimBlocked(AgentToolError):
    """The task's contract or dependencies do not allow work to start yet."""


class AgentOperationConflict(AgentToolError):
    """An operation ID was reused for a different request."""


@contextmanager
def _transaction():
    if settings.database_url is None:
        raise RuntimeError("DATABASE_URL is not configured")
    database_url = settings.database_url.get_secret_value()
    if not database_url.strip():
        raise RuntimeError("DATABASE_URL is empty")
    with psycopg.connect(database_url, connect_timeout=10, row_factory=dict_row) as connection:
        connection.execute("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
        yield connection


def _current_role(connection, identity: dict, project_id: UUID) -> str:
    """Return the owner's live role, holding the grant stable until commit."""
    row = connection.execute(
        """SELECT membership.role
           FROM public.agents AS agent
           JOIN public.agent_project_grants AS project_grant
             ON project_grant.agent_id = agent.id
            AND project_grant.owner_user_id = agent.owner_user_id
           JOIN public.project_memberships AS membership
             ON membership.project_id = project_grant.project_id
            AND membership.user_id = agent.owner_user_id
           WHERE agent.id = %s AND agent.owner_user_id = %s
             AND project_grant.project_id = %s
             AND agent.grant_status = 'active' AND project_grant.status = 'active'
           FOR SHARE OF agent, project_grant, membership""",
        (identity["agentId"], identity["ownerId"], project_id),
    ).fetchone()
    if row is None:
        raise AgentAccessDenied("This agent does not have access to that project")
    return row["role"]


def claim_blockers(task: dict, agent_id: str | None = None) -> list[str]:
    """Explain why a task cannot be claimed; an empty list means it can."""
    blockers = []
    if agent_id is not None and task.get("assigned_agent_id") not in (None, agent_id):
        blockers.append("Task is assigned to another agent")
    if task["status"] != "open":
        blockers.append(f"Task status is {task['status']}, not open")

    # Fail closed: without an approved review, nobody has agreed to this work.
    review = task["contract_review"]
    if review == "pending":
        blockers.append("Contract is waiting for human approval")
    elif review == "rejected":
        blockers.append("Contract was rejected by a human reviewer")
    elif review != "approved":
        blockers.append("Contract has no approved review")

    for prerequisite in task["dependencies"]:
        if prerequisite["status"] not in FINISHED_STATUSES:
            blockers.append(
                f"Waiting for dependency '{prerequisite['title']}' "
                f"(status: {prerequisite['status']})"
            )
    return blockers


def _timestamp(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _public_task(task: dict, agent_id: str | None = None) -> dict[str, Any]:
    blockers = claim_blockers(task, agent_id)
    return {
        "id": task["id"],
        "title": task["title"],
        "description": task["description"],
        "status": task["status"],
        "version": task["version"],
        "progress": task["progress"],
        "assignedAgentId": task.get("assigned_agent_id"),
        "claimedByAgentId": task["claimed_by_agent_id"],
        "claimedAt": _timestamp(task["claimed_at"]),
        "updatedAt": _timestamp(task["updated_at"]),
        "contract": {
            "version": task["contract_version"],
            "summary": task["contract_summary"],
            "paths": task["contract_paths"],
            "acceptanceCriteria": task["acceptance_criteria"],
            "review": task["contract_review"],
        },
        "dependencies": task["dependencies"],
        "claimable": not blockers,
        "claimBlockers": blockers,
    }


def _load_task(connection, project_id: UUID, task_id: UUID) -> dict:
    task = connection.execute(
        _TASK_SELECT + " WHERE t.project_id = %s AND t.id = %s",
        (project_id, task_id),
    ).fetchone()
    if task is None:
        raise AgentTaskNotFound("Task not found in this project")
    return task


def _lock_task(connection, project_id: UUID, task_id: UUID) -> dict:
    """Lock the task, then read it. Callers must already hold the project lock."""
    connection.execute(
        "SELECT id FROM public.tasks WHERE project_id = %s AND id = %s FOR UPDATE",
        (project_id, task_id),
    )
    return _load_task(connection, project_id, task_id)


def _record_activity(connection, identity: dict, project_id: UUID, task_id: UUID,
                     kind: str, text: str) -> None:
    project = connection.execute(
        """UPDATE public.projects SET activity_sequence = activity_sequence + 1
           WHERE id = %s RETURNING activity_sequence""",
        (project_id,),
    ).fetchone()
    connection.execute(
        """INSERT INTO public.project_activity
               (project_id, sequence, task_id, actor_user_id, actor_agent_id,
                actor_name, kind, text)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
        (project_id, project["activity_sequence"], task_id, identity["ownerId"],
         identity["agentId"], identity["name"], kind, text),
    )


def _post_task_update(connection, identity: dict, project_id: UUID, task: dict,
                      version: int, status: str, progress: str | None = None) -> None:
    """Publish a lifecycle message inside the authenticated task transaction.

    Operation replay skips apply(), so retries cannot duplicate these messages.
    Metadata lives in the existing JSON column; it is not a model reply.
    """
    messages = {
        'claimed': f"I claimed “{task['title']}”.",
        'in_progress': f"I'm working on “{task['title']}”.",
        'in_review': f"I finished “{task['title']}” and submitted it for review.",
        'blocked': f"I'm blocked on “{task['title']}”.",
    }
    body = messages[status]
    if progress:
        body += '\n\n' + progress[:7000]
    connection.execute("""INSERT INTO public.agent_room_exchanges
        (project_id, sender_agent_id, sender_name, operation_id, body, response,
         state, lease, lease_until, completed_at)
        VALUES (%s,%s,%s,%s,%s,%s,'complete',%s,now(),now())""",
        (project_id, identity['agentId'], identity['name'], uuid4(), body,
         Jsonb({'taskEvent': {'taskId': str(task['id']), 'taskVersion': version,
                             'status': status}}), uuid4()))


def _run_operation(identity: dict, project_id: UUID, operation_type: str,
                   operation_id: UUID, request: dict,
                   apply: Callable[[Any, int], dict]) -> dict:
    """Apply one write atomically, replaying the saved result on an exact retry."""
    payload = {"agentId": identity["agentId"], "projectId": str(project_id), **request}
    with _transaction() as connection:
        # Operations belong to the accountable human, as with the human API.
        # The payload names the agent, so two agents cannot share an operation.
        reservation = connection.execute(
            """INSERT INTO public.operations
                   (actor_id, operation_id, operation_type, request_payload)
               VALUES (%s, %s, %s, %s)
               ON CONFLICT (actor_id, operation_id) DO NOTHING
               RETURNING operation_id""",
            (identity["ownerId"], operation_id, operation_type, Jsonb(payload)),
        ).fetchone()

        # Check permission on retries too: access may have been removed since.
        if _current_role(connection, identity, project_id) not in WRITE_ROLES:
            raise AgentAccessDenied("The agent's owner cannot change this project")

        if reservation is None:
            existing = connection.execute(
                """SELECT operation_type, request_payload, response_payload
                   FROM public.operations WHERE actor_id = %s AND operation_id = %s""",
                (identity["ownerId"], operation_id),
            ).fetchone()
            if (existing is None or existing["operation_type"] != operation_type
                    or existing["request_payload"] != payload):
                raise AgentOperationConflict("Operation ID was already used for another request")
            if existing["response_payload"] is None:
                raise RuntimeError("Operation has no saved response")
            return existing["response_payload"]

        # Lock the project first, matching the human task lock order. The bump
        # tells the dashboard that the project changed. Agents guard against
        # conflicting work using the task version instead of the project's.
        project = connection.execute(
            "UPDATE public.projects SET version = version + 1 WHERE id = %s RETURNING version",
            (project_id,),
        ).fetchone()
        if project is None:
            raise AgentAccessDenied("This agent does not have access to that project")

        result = apply(connection, project["version"])
        connection.execute(
            """UPDATE public.operations SET response_payload = %s
               WHERE actor_id = %s AND operation_id = %s""",
            (Jsonb(result), identity["ownerId"], operation_id),
        )
    # Any exception rolls back the change, counters, and reservation together.
    return result


def list_tasks(identity: dict, project_id: UUID, status: str | None = None) -> dict[str, Any]:
    """Return the project and its tasks, with whether each can be claimed."""
    with _transaction() as connection:
        _current_role(connection, identity, project_id)
        project = connection.execute(
            """SELECT id::text AS id, name, repository, description, version
               FROM public.projects WHERE id = %s""",
            (project_id,),
        ).fetchone()
        tasks = connection.execute(
            _TASK_SELECT + """ WHERE t.project_id = %s AND (%s::text IS NULL OR t.status = %s)
                               ORDER BY t.created_at, t.id LIMIT %s""",
            (project_id, status, status, TASK_LIMIT),
        ).fetchall()
    return {"project": project, "tasks": [_public_task(task, identity["agentId"]) for task in tasks]}


def get_task(identity: dict, project_id: UUID, task_id: UUID) -> dict[str, Any]:
    """Return one task with the latest messages in its thread."""
    with _transaction() as connection:
        _current_role(connection, identity, project_id)
        task = _load_task(connection, project_id, task_id)
        messages = connection.execute(
            """SELECT id, sequence, sender_name, sender_agent_id, type, body,
                      reply_to_message_id, created_at
               FROM public.messages WHERE project_id = %s AND task_id = %s
               ORDER BY sequence DESC LIMIT %s""",
            (project_id, task_id, MESSAGE_LIMIT),
        ).fetchall()
    return {**_public_task(task, identity["agentId"]), "messages": [
        {"id": message["id"], "sequence": message["sequence"],
         "sender": message["sender_name"], "senderAgentId": message["sender_agent_id"],
         "type": message["type"], "body": message["body"],
         "replyTo": message["reply_to_message_id"],
         "createdAt": _timestamp(message["created_at"])}
        for message in reversed(messages)
    ]}


def claim_task(identity: dict, project_id: UUID, task_id: UUID,
               expected_version: int, operation_id: UUID) -> dict:
    """Claim an open task whose contract is approved and dependencies finished."""
    def apply(connection, project_version: int) -> dict:
        task = _lock_task(connection, project_id, task_id)
        if task["version"] != expected_version:
            raise AgentTaskConflict(
                f"Task changed (now version {task['version']}); reload before claiming"
            )
        # The project lock also serializes reviews and status changes, so these
        # conditions cannot change between this check and the update below.
        blockers = claim_blockers(task, identity["agentId"])
        if blockers:
            raise AgentClaimBlocked("Task cannot be claimed: " + "; ".join(blockers))
        updated = connection.execute(
            """UPDATE public.tasks
               SET status = 'claimed', claimed_by_agent_id = %s,
                   claimed_at = clock_timestamp(), version = version + 1,
                   updated_at = clock_timestamp()
               WHERE project_id = %s AND id = %s RETURNING version""",
            (identity["agentId"], project_id, task_id),
        ).fetchone()
        _record_activity(connection, identity, project_id, task_id, "task_claimed",
                         f"Claimed task: {task['title']}")
        _post_task_update(connection, identity, project_id, task, updated['version'], 'claimed')
        return {"projectId": str(project_id), "projectVersion": project_version,
                "taskId": str(task_id), "taskVersion": updated["version"],
                "status": "claimed"}

    return _run_operation(identity, project_id, "agent_claim_task", operation_id,
                          {"taskId": str(task_id), "expectedVersion": expected_version}, apply)


def update_task(identity: dict, project_id: UUID, task_id: UUID, expected_version: int,
                operation_id: UUID, status: str | None = None,
                progress: str | None = None) -> dict:
    """Report status or progress on a task claimed by this same agent."""
    if status is None and progress is None:
        raise AgentTaskConflict("Provide a status, progress, or both")

    def apply(connection, project_version: int) -> dict:
        task = _lock_task(connection, project_id, task_id)
        if task["claimed_by_agent_id"] != identity["agentId"]:
            raise AgentTaskConflict("Only the agent holding the claim can update this task")
        if task["version"] != expected_version:
            raise AgentTaskConflict(
                f"Task changed (now version {task['version']}); reload before updating"
            )
        allowed = AGENT_TRANSITIONS.get(task["status"])
        if allowed is None:
            raise AgentTaskConflict(f"Agents cannot change a task that is {task['status']}")
        if status is not None and status != task["status"] and status not in allowed:
            raise AgentTaskConflict(
                f"Cannot move a task from {task['status']} to {status}; "
                f"allowed: {', '.join(allowed)}"
            )
        updated = connection.execute(
            """UPDATE public.tasks
               SET status = COALESCE(%s, status), progress = COALESCE(%s, progress),
                   version = version + 1, updated_at = clock_timestamp()
               WHERE project_id = %s AND id = %s RETURNING version, status""",
            (status, progress, project_id, task_id),
        ).fetchone()
        # Progress notes are frequent; the timeline records only status changes.
        if updated["status"] != task["status"]:
            _record_activity(connection, identity, project_id, task_id, "task_status_changed",
                             f"Moved task to {updated['status']}: {task['title']}")
            _post_task_update(connection, identity, project_id, task, updated['version'],
                              updated['status'], progress)
        return {"projectId": str(project_id), "projectVersion": project_version,
                "taskId": str(task_id), "taskVersion": updated["version"],
                "status": updated["status"]}

    return _run_operation(identity, project_id, "agent_update_task", operation_id,
                          {"taskId": str(task_id), "expectedVersion": expected_version,
                           "status": status, "progress": progress}, apply)


def post_message(identity: dict, project_id: UUID, task_id: UUID, message_type: str,
                 body: str, operation_id: UUID, reply_to: str | None = None) -> dict:
    """Add an agent message to a task thread. Task status does not change."""
    def apply(connection, project_version: int) -> dict:
        # This also locks the task row until the transaction finishes.
        task = connection.execute(
            """UPDATE public.tasks SET message_sequence = message_sequence + 1
               WHERE project_id = %s AND id = %s RETURNING message_sequence""",
            (project_id, task_id),
        ).fetchone()
        if task is None:
            raise AgentTaskNotFound("Task not found in this project")
        if reply_to is not None and connection.execute(
            """SELECT id FROM public.messages
               WHERE id = %s AND project_id = %s AND task_id = %s FOR KEY SHARE""",
            (reply_to, project_id, task_id),
        ).fetchone() is None:
            raise AgentTaskNotFound("Reply target must belong to this task")

        message_id = str(uuid4())
        # The display name comes from the authenticated identity, not the tool input.
        connection.execute(
            """INSERT INTO public.messages
                   (id, sender_agent_id, sender_user_id, sender_name, project_id,
                    task_id, sequence, body, type, reply_to_message_id, created_at)
               VALUES (%s, %s, NULL, %s, %s, %s, %s, %s, %s, %s, clock_timestamp())""",
            (message_id, identity["agentId"], identity["name"], project_id, task_id,
             task["message_sequence"], body, message_type, reply_to),
        )
        return {"projectId": str(project_id), "projectVersion": project_version,
                "taskId": str(task_id), "messageId": message_id,
                "sequence": task["message_sequence"]}

    return _run_operation(identity, project_id, "agent_post_message", operation_id,
                          {"taskId": str(task_id), "type": message_type, "body": body,
                           "replyTo": reply_to}, apply)


def get_assignments(identity: dict, project_id: UUID) -> dict:
    """Read this agent's unfinished assignments without claiming or starting work."""
    with _transaction() as connection:
        role = _current_role(connection, identity, project_id)
        if role not in WRITE_ROLES:
            raise AgentAccessDenied("The agent's owner cannot execute assignments")
        project = connection.execute(
            """SELECT COALESCE(NULLIF(trim(tracked_branch), ''), 'main') AS push_branch
               FROM public.projects WHERE id=%s AND disconnected_at IS NULL""",
            (project_id,),
        ).fetchone()
        if project is None:
            raise AgentAccessDenied("Project access is unavailable")
        tasks = connection.execute(
            _TASK_SELECT + """ WHERE t.project_id=%s AND t.assigned_agent_id=%s
                               AND t.status NOT IN ('approved', 'merged', 'cancelled')
                               ORDER BY t.created_at, t.id LIMIT %s""",
            (project_id, identity["agentId"], TASK_LIMIT + 1),
        ).fetchall()
    return {"projectId": str(project_id), "agentId": identity["agentId"],
            "pushBranch": project["push_branch"],
            "tasks": [_public_task(task, identity["agentId"]) for task in tasks[:TASK_LIMIT]],
            "truncated": len(tasks) > TASK_LIMIT}
