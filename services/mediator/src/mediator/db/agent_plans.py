"""Agent proposals use the same grant checks and retry transactions as task tools."""
from uuid import UUID
from psycopg.types.json import Jsonb

from mediator.db.agent_tasks import _run_operation
from mediator.schemas.plans import PlanProposal


def propose_plan(identity: dict, project_id: UUID, operation_id: UUID,
                 proposal: PlanProposal) -> dict:
    # Revalidate even when this function is called outside the MCP transport.
    content = PlanProposal.model_validate(proposal).model_dump(mode="json")

    def apply(connection, project_version: int) -> dict:
        plan = connection.execute(
            """INSERT INTO public.plan_proposals(project_id,created_by)
               VALUES (%s,%s) RETURNING id""",
            (project_id, identity["ownerId"]),
        ).fetchone()
        # Identity comes from authentication, never from model-supplied fields.
        connection.execute(
            """INSERT INTO public.plan_proposal_revisions
               (project_id,plan_id,version,project_version,created_by,proposal,
                source,submitted_by_agent_id)
               VALUES (%s,%s,1,%s,%s,%s,'agent',%s)""",
            (project_id, plan["id"], project_version, identity["ownerId"],
             Jsonb(content), identity["agentId"]),
        )
        return {"projectId": str(project_id), "projectVersion": project_version,
                "planId": str(plan["id"]), "planVersion": 1, "status": "draft",
                "message": "Saved for human review in Plans. No tasks were created."}

    # Rechecks live grants and owner/reviewer membership on retries as well.
    return _run_operation(identity, project_id, "agent_propose_plan", operation_id,
                          {"proposal": content}, apply)
