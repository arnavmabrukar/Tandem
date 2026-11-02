from uuid import UUID

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from mediator.config import settings
from mediator.db.projects import OperationConflict, ProjectAccessDenied, ProjectVersionConflict
from mediator.schemas.approvals import DecideContractRequest, DecideContractResponse


class ApprovalNotFound(Exception):
    """The approval does not belong to this project."""


class ApprovalConflict(Exception):
    """The review is already decided or its target has changed."""


def decide_contract(
    actor_id: UUID,
    project_id: UUID,
    approval_id: UUID,
    request: DecideContractRequest,
) -> DecideContractResponse:
    """Record one human decision atomically, with safe retries."""
    if settings.database_url is None:
        raise RuntimeError("DATABASE_URL is not configured")
    database_url = settings.database_url.get_secret_value()
    if not database_url.strip():
        raise RuntimeError("DATABASE_URL is empty")

    payload = {
        "projectId": str(project_id),
        "approvalId": str(approval_id),
        **request.model_dump(mode="json"),
    }
    with psycopg.connect(database_url, connect_timeout=10, row_factory=dict_row) as connection:
        connection.execute("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
        # A concurrent retry waits here until the original operation commits.
        reservation = connection.execute(
            """
            INSERT INTO public.operations
                (actor_id, operation_id, operation_type, request_payload)
            VALUES (%s, %s, 'decide_contract', %s)
            ON CONFLICT (actor_id, operation_id) DO NOTHING
            RETURNING operation_id
            """,
            (actor_id, request.operationId, Jsonb(payload)),
        ).fetchone()

        # Check current membership even for a previously successful request.
        membership = connection.execute(
            """SELECT role FROM public.project_memberships
               WHERE project_id = %s AND user_id = %s FOR SHARE""",
            (project_id, actor_id),
        ).fetchone()
        if membership is None or membership["role"] not in ("owner", "reviewer"):
            raise ProjectAccessDenied("Project owner or reviewer access is required")

        if reservation is None:
            existing = connection.execute(
                """SELECT operation_type, request_payload, response_payload
                   FROM public.operations WHERE actor_id = %s AND operation_id = %s""",
                (actor_id, request.operationId),
            ).fetchone()
            if existing is None or existing["response_payload"] is None:
                raise RuntimeError("Operation has no saved response")
            if existing["operation_type"] != "decide_contract" or existing["request_payload"] != payload:
                raise OperationConflict("Operation ID was already used for another request")
            # Do not reapply the decision or recheck the old project version.
            result = DecideContractResponse.model_validate(existing["response_payload"])
        else:
            # Lock the project first, matching the task mutation lock order.
            project = connection.execute(
                """UPDATE public.projects SET version = version + 1
                   WHERE id = %s AND version = %s RETURNING id, version, repository""",
                (project_id, request.expectedVersion),
            ).fetchone()
            if project is None:
                raise ProjectVersionConflict("Project changed; reload before deciding")

            approval = connection.execute(
                """SELECT * FROM public.contract_approvals
                   WHERE project_id = %s AND id = %s""",
                (project_id, approval_id),
            ).fetchone()
            if approval is None:
                raise ApprovalNotFound("Approval not found in this project")

            # Hold the task stable while checking the snapshot and deciding.
            task = connection.execute(
                """SELECT version, contract_version, status, contract_summary,
                          contract_paths, acceptance_criteria
                   FROM public.tasks WHERE project_id = %s AND id = %s FOR UPDATE""",
                (project_id, approval["task_id"]),
            ).fetchone()
            target = request.target
            if (
                task is None
                or approval["status"] != "pending"
                or task["status"] != "open"
                or target.repository != approval["repository"]
                or target.repository != project["repository"]
                or target.taskVersion != approval["task_version"]
                or target.taskVersion != task["version"]
                or target.contractVersion != approval["contract_version"]
                or target.contractVersion != task["contract_version"]
                or any(approval[key] != task[key] for key in (
                    "contract_summary", "contract_paths", "acceptance_criteria"
                ))
            ):
                raise ApprovalConflict("Review target changed or was already decided; reload")

            # The reviewer identity and display name come from the server.
            # The conditional update also prevents overwriting a prior decision.
            saved = connection.execute(
                """UPDATE public.contract_approvals AS approval
                   SET status = %s, decided_by = %s, decided_by_name = reviewer.name,
                       decided_at = clock_timestamp(), note = %s
                   FROM public.users AS reviewer
                   WHERE approval.project_id = %s AND approval.id = %s
                     AND approval.status = 'pending' AND reviewer.id = %s
                   RETURNING approval.id""",
                (request.decision, actor_id, request.note, project_id, approval_id, actor_id),
            ).fetchone()
            if saved is None:
                raise ApprovalConflict("Approval could not be decided; reload")

            # Approving scope does not mark the task's work as completed.
            result = DecideContractResponse(
                projectId=project_id, projectVersion=project["version"], entityId=approval_id
            )
            connection.execute(
                """UPDATE public.operations SET response_payload = %s
                   WHERE actor_id = %s AND operation_id = %s""",
                (Jsonb(result.model_dump(mode="json")), actor_id, request.operationId),
            )
    # Any exception rolls back the decision, version bump, and reservation.
    return result
