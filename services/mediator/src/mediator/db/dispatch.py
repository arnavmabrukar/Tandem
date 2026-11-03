"""Recurring delegation. No model calls, task execution, or automatic approval."""
import logging
from threading import Event
from uuid import UUID, uuid4

import psycopg
from psycopg.types.json import Jsonb

from mediator.db import agent_tasks
from mediator.db.activity import record_task_activity
from mediator.db.assignments import assign_task
from mediator.db.projects import OperationConflict, ProjectAccessDenied, ProjectVersionConflict
from mediator.schemas.assignments import AssignTaskRequest, AutoDelegateRequest

logger = logging.getLogger(__name__)


def set_auto_delegate(actor_id: UUID, project_id: UUID, request: AutoDelegateRequest) -> dict:
    payload = {"projectId": str(project_id), **request.model_dump(mode="json")}
    with agent_tasks._transaction() as connection:
        reserved = connection.execute(
            """INSERT INTO public.operations (actor_id,operation_id,operation_type,request_payload)
               VALUES (%s,%s,'auto_delegate',%s)
               ON CONFLICT (actor_id,operation_id) DO NOTHING RETURNING operation_id""",
            (actor_id, request.operationId, Jsonb(payload)),
        ).fetchone()
        member = connection.execute(
            "SELECT role FROM public.project_memberships WHERE project_id=%s AND user_id=%s FOR SHARE",
            (project_id, actor_id),
        ).fetchone()
        if member is None or member["role"] != "owner":
            raise ProjectAccessDenied("Only project owners can change automatic delegation")
        if reserved is None:
            prior = connection.execute(
                "SELECT * FROM public.operations WHERE actor_id=%s AND operation_id=%s",
                (actor_id, request.operationId),
            ).fetchone()
            if prior["operation_type"] != "auto_delegate" or prior["request_payload"] != payload:
                raise OperationConflict("Operation ID was already used for another request")
            return prior["response_payload"]
        project = connection.execute(
            """UPDATE public.projects SET auto_delegate=%s,auto_delegate_by=%s,version=version+1
               WHERE id=%s AND version=%s RETURNING version""",
            (request.enabled, actor_id if request.enabled else None, project_id, request.expectedVersion),
        ).fetchone()
        if project is None:
            raise ProjectVersionConflict("Project changed; refresh before changing delegation")
        result = {"projectId": str(project_id), "projectVersion": project["version"],
                  "entityId": str(project_id), "autoDelegate": request.enabled}
        connection.execute(
            "UPDATE public.operations SET response_payload=%s WHERE actor_id=%s AND operation_id=%s",
            (Jsonb(result), actor_id, request.operationId),
        )
    return result


def return_stale_assignments(project_id: UUID, actor_id: UUID) -> int:
    """Requeue unstarted automatic assignments whose agent has gone offline.

    Claims are left alone: that agent may have work in progress, and a second agent
    could duplicate it. A person decides those with the task's Release action.
    """
    stale_query = """t.project_id=%s AND t.status='open' AND t.auto_assigned
                     AND t.claimed_by_agent_id IS NULL
                     AND t.assigned_agent_id IN (SELECT a.id FROM public.agents a
                         WHERE a.last_seen_at IS NULL
                            OR a.last_seen_at <= now() - interval '15 minutes')"""
    with agent_tasks._transaction() as connection:
        connection.execute("SET LOCAL statement_timeout = '5s'")
        # Check without locks first, since nearly every sweep finds nothing.
        if connection.execute(f"SELECT 1 FROM public.tasks t WHERE {stale_query} LIMIT 1",
                              (project_id,)).fetchone() is None:
            return 0
        # Lock the project before tasks, matching every other task writer.
        connection.execute("UPDATE public.projects SET version=version+1 WHERE id=%s", (project_id,))
        tasks = connection.execute(
            f"""UPDATE public.tasks t SET assigned_agent_id=NULL, auto_assigned=false,
                   updated_at=clock_timestamp()
               WHERE {stale_query} RETURNING t.id, t.title""",
            (project_id,),
        ).fetchall()
        for task in tasks:
            record_task_activity(connection, project_id=project_id, task_id=task["id"],
                                 actor_id=actor_id, kind="task_released",
                                 text=f"Took back from an offline agent: {task['title']}")
    return len(tasks)


def dispatch_once(stop: Event | None = None) -> int:
    """Assign up to 100 ready tasks per opted-in project per sweep.

    Each write rechecks permissions, policy, readiness, and project version inside
    the existing assignment transaction. Multiple web workers can safely race.
    Failed attempts roll back their operation reservations and are retried later.
    """
    with agent_tasks._transaction() as connection:
        connection.execute("SET LOCAL statement_timeout = '5s'")
        projects = connection.execute(
            """SELECT p.id, p.auto_delegate_by FROM public.projects p
               JOIN public.project_memberships m ON m.project_id=p.id AND m.user_id=p.auto_delegate_by
               WHERE p.auto_delegate AND m.role='owner' ORDER BY p.id"""
        ).fetchall()
    assigned = 0
    for project in projects:
        if stop is not None and stop.is_set():
            break
        try:
            return_stale_assignments(project["id"], project["auto_delegate_by"])
            with agent_tasks._transaction() as connection:
                connection.execute("SET LOCAL statement_timeout = '5s'")
                # Filter before LIMIT so blocked old tasks cannot starve ready ones.
                tasks = connection.execute(
                    """SELECT t.id FROM public.tasks t WHERE t.project_id=%s
                       AND t.status='open' AND t.assigned_agent_id IS NULL
                       AND t.claimed_by_agent_id IS NULL
                       AND (SELECT a.status FROM public.contract_approvals a
                            WHERE a.project_id=t.project_id AND a.task_id=t.id
                              AND a.contract_version=t.contract_version
                            ORDER BY a.requested_at DESC,a.id DESC LIMIT 1)='approved'
                       AND NOT EXISTS (SELECT 1 FROM public.task_dependencies d
                           JOIN public.tasks prerequisite ON prerequisite.id=d.depends_on_task_id
                             AND prerequisite.project_id=d.project_id
                           WHERE d.project_id=t.project_id AND d.task_id=t.id
                             AND prerequisite.status NOT IN ('approved','merged'))
                       ORDER BY t.created_at,t.id LIMIT 100""", (project["id"],),
                ).fetchall()
            for task in tasks:
                if stop is not None and stop.is_set():
                    break
                with agent_tasks._transaction() as connection:
                    connection.execute("SET LOCAL statement_timeout = '5s'")
                    version = connection.execute(
                        "SELECT version FROM public.projects WHERE id=%s", (project["id"],),
                    ).fetchone()
                if version is None:
                    break
                try:
                    assign_task(project["auto_delegate_by"], project["id"], task["id"],
                                AssignTaskRequest(operationId=uuid4(), expectedVersion=version["version"],
                                                  agentId=None, autoSelect=True), automatic=True)
                    assigned += 1
                except (ProjectVersionConflict, agent_tasks.AgentToolError):
                    # Concurrent edits or no eligible agent: retry next sweep.
                    break
        except ProjectAccessDenied:
            continue
        except (psycopg.Error, RuntimeError) as error:
            logger.warning("Auto-delegation project check failed: %s", type(error).__name__)
    return assigned


def run_dispatcher(stop: Event) -> None:
    """Wait between sweeps; shutdown interrupts the wait and stops further work."""
    while not stop.wait(15):
        try:
            dispatch_once(stop)
        except (psycopg.Error, RuntimeError) as error:
            # A database outage must not kill dispatch permanently or leak a DSN.
            logger.warning("Auto-delegation sweep failed: %s", type(error).__name__)
