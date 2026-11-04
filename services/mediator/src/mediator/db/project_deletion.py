"""Permanently delete a Tandem project and everything stored for it.

GitHub is never contacted: repositories, branches, and pull requests are unaffected.
Add any new table holding project data to delete_project_data. The integration test
scans every table for leftovers, so a table missed here fails that test.
"""
from uuid import UUID

from psycopg.types.json import Jsonb

from mediator.db.agent_tasks import _transaction
from mediator.db.projects import OperationConflict, ProjectAccessDenied, ProjectVersionConflict

# Children come first, because several foreign keys here refuse to cascade.
_PROJECT_TABLES = (
    "agent_room_exchanges",  # Its project and agent references do not cascade.
    "messages",  # Also removes their deliveries.
    "contract_approvals",
    "project_activity",
    "plan_tasks",
    "plan_approvals",
    "plan_proposal_revisions",
    "plan_proposals",
    "task_dependencies",
    "tasks",
    "project_invitations",
    "mcp_oauth_sessions",  # Also removes their OAuth codes and tokens.
    "agent_project_grants",
    "project_memberships",
)


def delete_unused_agents(db, agent_ids: list[str] | None = None) -> int:
    """Delete agents with no project left. Each holds a credential hash nothing can use.

    Rows that older records still point to are kept, since those references block deletion.
    """
    return db.execute(
        """DELETE FROM public.agents AS agent
           WHERE (%(ids)s::text[] IS NULL OR agent.id = ANY(%(ids)s::text[]))
             AND NOT EXISTS (SELECT 1 FROM public.agent_project_grants g WHERE g.agent_id = agent.id)
             AND NOT EXISTS (SELECT 1 FROM public.messages m WHERE m.sender_agent_id = agent.id)
             AND NOT EXISTS (SELECT 1 FROM public.deliveries d WHERE d.recipient_agent_id = agent.id)
             AND NOT EXISTS (SELECT 1 FROM public.tasks t WHERE t.assigned_agent_id = agent.id)
             AND NOT EXISTS (SELECT 1 FROM public.plan_proposal_revisions r
                             WHERE r.submitted_by_agent_id = agent.id)""",
        {"ids": agent_ids},
    ).rowcount


def delete_project_data(db, project_id: UUID, *, keep_operation: tuple[UUID, UUID] | None = None) -> None:
    """Delete all of a project's rows inside the caller's transaction."""
    agents = [row["agent_id"] for row in db.execute(
        "SELECT agent_id FROM public.agent_project_grants WHERE project_id = %s", (project_id,)
    ).fetchall()]

    # Retry records hold copies of messages, plans, and invitations for every member.
    # They have no foreign key to the project, so match on its ID.
    keep_actor, keep_id = keep_operation or (None, None)
    pattern = f"%{project_id}%"
    db.execute(
        """DELETE FROM public.operations
           WHERE (request_payload::text LIKE %s OR response_payload::text LIKE %s)
             AND NOT (actor_id IS NOT DISTINCT FROM %s AND operation_id IS NOT DISTINCT FROM %s)""",
        (pattern, pattern, keep_actor, keep_id),
    )
    for table in _PROJECT_TABLES:
        # Table names come only from the constant above, never from input.
        db.execute(f"DELETE FROM public.{table} WHERE project_id = %s", (project_id,))
    db.execute("DELETE FROM public.projects WHERE id = %s", (project_id,))
    # Each agent belongs to one project, so these would otherwise be orphaned.
    delete_unused_agents(db, agents)


def delete_project(actor_id: UUID, project_id: UUID, request) -> dict:
    """Permanently delete the project if the caller is a current owner."""
    payload = {"projectId": str(project_id), **request.model_dump(mode="json")}
    with _transaction() as db:
        reserved = db.execute(
            """INSERT INTO public.operations (actor_id, operation_id, operation_type, request_payload)
               VALUES (%s, %s, 'delete_project', %s)
               ON CONFLICT DO NOTHING RETURNING operation_id""",
            (actor_id, request.operationId, Jsonb(payload)),
        ).fetchone()
        if reserved is None:
            # The project is gone by now, so this person's own saved receipt is the proof.
            # It holds only IDs and a version number, never project content.
            old = db.execute("SELECT * FROM public.operations WHERE actor_id = %s AND operation_id = %s",
                             (actor_id, request.operationId)).fetchone()
            if old["operation_type"] != "delete_project" or old["request_payload"] != payload:
                raise OperationConflict("Operation ID was already used for another request")
            if old["response_payload"] is None:
                raise RuntimeError("Operation has no saved response")
            return old["response_payload"]

        # Match other writers' membership-before-project lock order. Once this commits,
        # a waiting agent or invitation request finds no membership and is refused.
        members = db.execute(
            "SELECT user_id, role FROM public.project_memberships WHERE project_id = %s ORDER BY user_id FOR UPDATE",
            (project_id,),
        ).fetchall()
        if not any(member["user_id"] == actor_id and member["role"] == "owner" for member in members):
            raise ProjectAccessDenied("Only project owners can delete a project")
        project = db.execute("SELECT version FROM public.projects WHERE id = %s FOR UPDATE", (project_id,)).fetchone()
        if project is None or project["version"] != request.expectedVersion:
            raise ProjectVersionConflict("Project changed; refresh before deleting")

        delete_project_data(db, project_id, keep_operation=(actor_id, request.operationId))
        result = {"projectId": str(project_id), "entityId": str(project_id),
                  "projectVersion": project["version"] + 1}
        db.execute("UPDATE public.operations SET response_payload = %s WHERE actor_id = %s AND operation_id = %s",
                   (Jsonb(result), actor_id, request.operationId))
    # Any failure rolls back everything: a project is never left half deleted.
    return result
