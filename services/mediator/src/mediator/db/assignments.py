"""Human delegation, using the same readiness rules as MCP task claims."""
from uuid import UUID
from psycopg.types.json import Jsonb
from mediator.db import agent_tasks
from mediator.db.projects import OperationConflict, ProjectAccessDenied, ProjectVersionConflict
from mediator.schemas.assignments import AssignTaskRequest


def assign_task(actor_id: UUID, project_id: UUID, task_id: UUID,
                request: AssignTaskRequest, *, automatic: bool = False) -> dict:
    payload = {"projectId": str(project_id), "taskId": str(task_id),
               **request.model_dump(mode="json")}
    # Preserve the canonical payload used by manual assignment retries.
    if not request.autoSelect:
        payload.pop("autoSelect", None)
    selected_agent = request.agentId
    with agent_tasks._transaction() as connection:
        if automatic:
            # Bound each background attempt; the next sweep retries contention.
            connection.execute("SET LOCAL statement_timeout = '5s'")
        reserved = connection.execute(
            """INSERT INTO public.operations
               (actor_id, operation_id, operation_type, request_payload)
               VALUES (%s, %s, 'assign_task', %s)
               ON CONFLICT (actor_id, operation_id) DO NOTHING RETURNING operation_id""",
            (actor_id, request.operationId, Jsonb(payload)),
        ).fetchone()
        member = connection.execute(
            """SELECT role FROM public.project_memberships
               WHERE project_id=%s AND user_id=%s FOR SHARE""",
            (project_id, actor_id),
        ).fetchone()
        if member is None or member["role"] not in agent_tasks.WRITE_ROLES:
            raise ProjectAccessDenied("Project owner or reviewer access is required")
        if automatic and member["role"] != "owner":
            raise ProjectAccessDenied("Automatic delegation requires a current project owner")
        # Replays return the original receipt, without changing today's assignment.
        if reserved is None:
            previous = connection.execute(
                """SELECT operation_type, request_payload, response_payload
                   FROM public.operations WHERE actor_id=%s AND operation_id=%s""",
                (actor_id, request.operationId),
            ).fetchone()
            if previous["operation_type"] != "assign_task" or previous["request_payload"] != payload:
                raise OperationConflict("Operation ID was already used for another request")
            return previous["response_payload"]

        # Match agent-action lock order: grant/membership, then project, then task.
        candidates = []
        if request.autoSelect:
            # Lock eligibility before the project, matching normal agent actions.
            # Keep these locks through selection and commit so revocation cannot
            # slip between checking access and saving the chosen agent.
            candidates = connection.execute(
                """SELECT agent.id, agent.name
                   FROM public.agents agent
                   JOIN public.agent_project_grants g ON g.agent_id=agent.id
                     AND g.owner_user_id=agent.owner_user_id
                   JOIN public.project_memberships m ON m.project_id=g.project_id
                     AND m.user_id=agent.owner_user_id
                   WHERE g.project_id=%s AND g.status='active'
                     AND agent.grant_status='active' AND m.role IN ('owner','reviewer')
                     -- Background delegation must not strand work on an offline agent.
                     -- Uses the same 2-minute window as the dashboard's Online badge.
                     AND (NOT %s OR agent.last_seen_at > now() - interval '2 minutes')
                   ORDER BY agent.id FOR SHARE OF agent, g, m""",
                (project_id, automatic),
            ).fetchall()
            if not candidates:
                raise agent_tasks.AgentTaskConflict("No eligible agents; connect an agent with project write access first")
        elif request.agentId is not None:
            agent = connection.execute(
                "SELECT owner_user_id FROM public.agents WHERE id=%s", (request.agentId,),
            ).fetchone()
            if agent is None or agent["owner_user_id"] is None:
                raise agent_tasks.AgentAccessDenied("Agent is not eligible for this project")
            identity = {"agentId": request.agentId, "ownerId": agent["owner_user_id"]}
            if agent_tasks._current_role(connection, identity, project_id) not in agent_tasks.WRITE_ROLES:
                raise agent_tasks.AgentAccessDenied("Agent owner needs owner or reviewer access")
        project = connection.execute(
            """UPDATE public.projects SET version=version+1
               WHERE id=%s AND version=%s RETURNING version""",
            (project_id, request.expectedVersion),
        ).fetchone()
        if project is None:
            raise ProjectVersionConflict("Project changed; refresh before assigning")
        if automatic:
            # Read while holding the project lock: disabling wins before the next
            # assignment, even if this sweep read the old setting earlier.
            policy = connection.execute(
                "SELECT auto_delegate, auto_delegate_by FROM public.projects WHERE id=%s",
                (project_id,),
            ).fetchone()
            if not policy["auto_delegate"] or policy["auto_delegate_by"] != actor_id:
                raise ProjectAccessDenied("Automatic delegation is disabled or its owner changed")
        task = agent_tasks._lock_task(connection, project_id, task_id)
        if task["status"] != "open" or task["claimed_by_agent_id"] is not None:
            raise agent_tasks.AgentTaskConflict("Only open, unclaimed tasks can be assigned")
        if request.autoSelect:
            if task["assigned_agent_id"] is not None:
                raise agent_tasks.AgentTaskConflict("Task already has an assignment; clear it before automatic selection")
            # The project lock serializes selection against assignments and claims.
            # Count each unfinished task once, preferring its actual claim holder.
            # This is project-local load balancing, not a capability/model guess.
            loads = connection.execute(
                """SELECT COALESCE(claimed_by_agent_id, assigned_agent_id) AS agent_id,
                          count(*) AS load FROM public.tasks
                   WHERE project_id=%s AND status NOT IN ('approved','merged','cancelled')
                   GROUP BY COALESCE(claimed_by_agent_id, assigned_agent_id)""",
                (project_id,),
            ).fetchall()
            counts = {row["agent_id"]: row["load"] for row in loads}
            selected_agent = min(candidates, key=lambda agent: (counts.get(agent["id"], 0), agent["id"]))["id"]
        # Clearing an assignment is allowed even if a prerequisite became blocked.
        if selected_agent is not None:
            blockers = agent_tasks.claim_blockers(task)
            if blockers:
                raise agent_tasks.AgentClaimBlocked("Task is not ready: " + "; ".join(blockers))
        if task["assigned_agent_id"] == selected_agent:
            raise agent_tasks.AgentTaskConflict("Task already has this assignment")
        updated = connection.execute(
            """UPDATE public.tasks SET assigned_agent_id=%s, auto_assigned=%s,
                   updated_at=clock_timestamp()
               WHERE project_id=%s AND id=%s RETURNING version""",
            (selected_agent, automatic or request.autoSelect, project_id, task_id),
        ).fetchone()
        # Assignment metadata uses the project CAS above. It does not change the
        # task/contract review snapshot or invalidate an outstanding human review.
        from mediator.db.activity import record_task_activity
        record_task_activity(connection, project_id=project_id, task_id=task_id,
                             actor_id=actor_id, kind="task_assigned",
                             text=f"{'Automatic assignment' if automatic else 'Assignment'} {'cleared' if selected_agent is None else 'set to ' + selected_agent}: {task['title']}")
        result = {"projectId": str(project_id), "projectVersion": project["version"],
                  "entityId": str(task_id), "taskVersion": updated["version"],
                  "assignedAgentId": selected_agent,
                  "selection": "least_loaded" if request.autoSelect else "manual"}
        connection.execute(
            """UPDATE public.operations SET response_payload=%s
               WHERE actor_id=%s AND operation_id=%s""",
            (Jsonb(result), actor_id, request.operationId),
        )
    return result
