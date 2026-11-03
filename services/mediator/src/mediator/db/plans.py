"""Store human plan drafts; saving a draft does not create or approve tasks."""
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from mediator.config import settings
from mediator.db.activity import record_task_activity
from mediator.db.projects import (
    OperationConflict, ProjectAccessDenied, ProjectVersionConflict,
)
from mediator.schemas.plans import (
    CreatePlanRequest, RevisePlanRequest, SavePlanResponse, PlanRevisionResponse,
    ApprovePlanRequest, ApprovePlanResponse, PlanProposal,
)


class PlanNotFound(Exception):
    """The requested proposal or revision does not exist in this project."""


class PlanVersionConflict(Exception):
    """Another edit has already created a newer revision."""


def list_plans(actor_id: UUID, project_id: UUID) -> list[PlanRevisionResponse]:
    """Return the latest revision of the 100 most recently created proposals."""
    with _connect() as connection:
        _authorize(connection, actor_id, project_id, write=False)
        rows = connection.execute(
            '''SELECT r.project_id AS "projectId", r.project_version AS "projectVersion",
                      r.plan_id AS "planId", r.version AS "planVersion",
                      r.created_by AS "createdBy", r.created_at AS "createdAt", r.proposal,
                      (SELECT plan_version FROM public.plan_approvals WHERE plan_id=p.id) AS "approvedPlanVersion"
               FROM public.plan_proposals p
               CROSS JOIN LATERAL (
                   SELECT * FROM public.plan_proposal_revisions
                   WHERE plan_id = p.id AND project_id = p.project_id
                   ORDER BY version DESC LIMIT 1
               ) r
               WHERE p.project_id = %s
               ORDER BY p.created_at DESC, p.id DESC LIMIT 100''',
            (project_id,),
        ).fetchall()
        return [PlanRevisionResponse.model_validate(row) for row in rows]


def _connect():
    if settings.database_url is None:
        raise RuntimeError("DATABASE_URL is not configured")
    return psycopg.connect(settings.database_url.get_secret_value(),
                           connect_timeout=10, row_factory=dict_row)


def _authorize(connection, actor_id: UUID, project_id: UUID, *, write: bool):
    # Hold membership stable through the transaction, including on retries.
    membership = connection.execute(
        """SELECT role FROM public.project_memberships
           WHERE project_id = %s AND user_id = %s FOR SHARE""",
        (project_id, actor_id),
    ).fetchone()
    allowed = {"owner"} if write else {"owner", "reviewer", "viewer"}
    if membership is None or membership["role"] not in allowed:
        raise ProjectAccessDenied("Project owner access is required" if write
                                  else "Project membership is required")


def create_plan(actor_id: UUID, project_id: UUID,
                request: CreatePlanRequest) -> SavePlanResponse:
    return _save_plan(actor_id, project_id, request, plan_id=None)


def revise_plan(actor_id: UUID, project_id: UUID, plan_id: UUID,
                request: RevisePlanRequest) -> SavePlanResponse:
    return _save_plan(actor_id, project_id, request, plan_id=plan_id)


def _save_plan(actor_id, project_id, request, *, plan_id):
    operation_type = "create_plan" if plan_id is None else "revise_plan"
    # Include route identifiers so a retry cannot target a different project.
    payload = {"projectId": str(project_id),
               "planId": str(plan_id) if plan_id else None,
               **request.model_dump(mode="json")}
    with _connect() as connection:
        connection.execute("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
        reservation = connection.execute(
            """INSERT INTO public.operations
                   (actor_id, operation_id, operation_type, request_payload)
               VALUES (%s, %s, %s, %s)
               ON CONFLICT (actor_id, operation_id) DO NOTHING
               RETURNING operation_id""",
            (actor_id, request.operationId, operation_type, Jsonb(payload)),
        ).fetchone()
        _authorize(connection, actor_id, project_id, write=True)

        if reservation is None:
            existing = connection.execute(
                """SELECT operation_type, request_payload, response_payload
                   FROM public.operations WHERE actor_id = %s AND operation_id = %s""",
                (actor_id, request.operationId),
            ).fetchone()
            if existing is None:
                raise RuntimeError("Reserved operation could not be found")
            if (existing["operation_type"] != operation_type
                    or existing["request_payload"] != payload):
                raise OperationConflict("Operation ID was already used for another request")
            # A retry returns the original version, without adding a revision.
            return SavePlanResponse.model_validate(existing["response_payload"])

        # Serialize project writes and reject changes based on an old workspace.
        # Any failure below rolls this increment back along with the reservation.
        project = connection.execute(
            """UPDATE public.projects SET version = version + 1
               WHERE id = %s AND version = %s RETURNING version""",
            (project_id, request.expectedVersion),
        ).fetchone()
        if project is None:
            raise ProjectVersionConflict("Project changed; reload before saving")

        if plan_id is None:
            parent = connection.execute(
                """INSERT INTO public.plan_proposals (project_id, created_by)
                   VALUES (%s, %s) RETURNING id""", (project_id, actor_id),
            ).fetchone()
            plan_id = parent["id"]
            version = 1
        else:
            parent = connection.execute(
                """SELECT id FROM public.plan_proposals
                   WHERE project_id = %s AND id = %s FOR UPDATE""",
                (project_id, plan_id),
            ).fetchone()
            if parent is None:
                raise PlanNotFound("Plan not found")
            if connection.execute("SELECT 1 FROM public.plan_approvals WHERE plan_id=%s", (plan_id,)).fetchone():
                raise PlanVersionConflict("Approved plans cannot be revised")
            latest = connection.execute(
                """SELECT max(version) AS version FROM public.plan_proposal_revisions
                   WHERE project_id = %s AND plan_id = %s""",
                (project_id, plan_id),
            ).fetchone()
            if latest["version"] != request.expectedPlanVersion:
                raise PlanVersionConflict("Plan changed; reload before saving")
            version = latest["version"] + 1

        # Append, never overwrite: old proposals remain available for review.
        # Model provenance will be handled by a separate trusted generation path.
        connection.execute(
            """INSERT INTO public.plan_proposal_revisions
                   (project_id, plan_id, version, project_version, created_by, proposal, source)
               VALUES (%s, %s, %s, %s, %s, %s, 'human')""",
            (project_id, plan_id, version, project["version"], actor_id,
             Jsonb(request.proposal.model_dump(mode="json"))),
        )
        result = SavePlanResponse(projectId=project_id, projectVersion=project["version"],
                                  planId=plan_id, planVersion=version)
        connection.execute(
            """UPDATE public.operations SET response_payload = %s
               WHERE actor_id = %s AND operation_id = %s""",
            (Jsonb(result.model_dump(mode="json")), actor_id, request.operationId),
        )
    return result


def get_plan(actor_id: UUID, project_id: UUID, plan_id: UUID,
             version: int | None = None) -> PlanRevisionResponse:
    """Load the latest revision, or an exact historical version."""
    with _connect() as connection:
        _authorize(connection, actor_id, project_id, write=False)
        row = connection.execute(
            """SELECT project_id AS "projectId", project_version AS "projectVersion",
                      plan_id AS "planId", version AS "planVersion",
                      created_by AS "createdBy", created_at AS "createdAt", proposal,
                      (SELECT plan_version FROM public.plan_approvals a WHERE a.plan_id=plan_proposal_revisions.plan_id) AS "approvedPlanVersion"
               FROM public.plan_proposal_revisions
               WHERE project_id = %s AND plan_id = %s
                 AND (%s::bigint IS NULL OR version = %s)
               ORDER BY version DESC LIMIT 1""",
            (project_id, plan_id, version, version),
        ).fetchone()
        if row is None:
            raise PlanNotFound("Plan revision not found")
        return PlanRevisionResponse.model_validate(row)


def approve_plan(actor_id: UUID, project_id: UUID, plan_id: UUID,
                 request: ApprovePlanRequest) -> ApprovePlanResponse:
    """Create the complete task graph, audit record and retry result atomically."""
    payload = {"projectId": str(project_id), "planId": str(plan_id),
               **request.model_dump(mode="json")}
    with _connect() as c:
        c.execute("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
        reserved = c.execute(
            """INSERT INTO public.operations(actor_id,operation_id,operation_type,request_payload)
               VALUES (%s,%s,'approve_plan',%s) ON CONFLICT DO NOTHING RETURNING operation_id""",
            (actor_id, request.operationId, Jsonb(payload)),
        ).fetchone()
        _authorize(c, actor_id, project_id, write=True)
        if reserved is None:
            old = c.execute("SELECT * FROM public.operations WHERE actor_id=%s AND operation_id=%s",
                            (actor_id, request.operationId)).fetchone()
            if old["operation_type"] != "approve_plan" or old["request_payload"] != payload:
                raise OperationConflict("Operation ID was already used for another request")
            return ApprovePlanResponse.model_validate(old["response_payload"])

        # All plan writers use project-before-plan locking to serialize edits.
        project = c.execute(
            """UPDATE public.projects SET version=version+1
               WHERE id=%s AND version=%s RETURNING version,repository""",
            (project_id, request.expectedVersion),
        ).fetchone()
        if project is None:
            raise ProjectVersionConflict("Project changed; reload before approving")
        parent = c.execute("SELECT id FROM public.plan_proposals WHERE project_id=%s AND id=%s FOR UPDATE",
                           (project_id, plan_id)).fetchone()
        if parent is None:
            raise PlanNotFound("Plan not found")
        if c.execute("SELECT 1 FROM public.plan_approvals WHERE plan_id=%s", (plan_id,)).fetchone():
            raise PlanVersionConflict("Plan already approved")
        revision = c.execute(
            """SELECT version,proposal FROM public.plan_proposal_revisions
               WHERE project_id=%s AND plan_id=%s ORDER BY version DESC LIMIT 1""",
            (project_id, plan_id),
        ).fetchone()
        if revision is None or revision["version"] != request.expectedPlanVersion:
            raise PlanVersionConflict("Plan changed; review the latest revision")
        # Validate stored content again before it becomes live work.
        proposal = PlanProposal.model_validate(revision["proposal"])
        ids = {task.key: uuid4() for task in proposal.tasks}
        c.execute(
            """INSERT INTO public.plan_approvals(plan_id,project_id,plan_version,approved_by,note)
               VALUES (%s,%s,%s,%s,%s)""",
            (plan_id, project_id, revision["version"], actor_id, request.note),
        )
        for task in proposal.tasks:
            task_id = ids[task.key]
            c.execute(
                """INSERT INTO public.tasks(id,project_id,created_by,title,description,
                       contract_summary,contract_paths,acceptance_criteria)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
                (task_id, project_id, actor_id, task.title, task.description,
                 task.contractSummary, task.paths, task.criteria),
            )
            c.execute("INSERT INTO public.plan_tasks(project_id,plan_id,task_key,task_id) VALUES (%s,%s,%s,%s)",
                      (project_id, plan_id, task.key, task_id))
            # Preserve the existing per-task human contract review gate.
            c.execute(
                """INSERT INTO public.contract_approvals(project_id,task_id,repository,
                       task_version,contract_version,contract_summary,contract_paths,acceptance_criteria)
                   VALUES (%s,%s,%s,1,1,%s,%s,%s)""",
                (project_id, task_id, project["repository"], task.contractSummary, task.paths, task.criteria),
            )
            record_task_activity(c, project_id=project_id, task_id=task_id, actor_id=actor_id,
                                 kind="task_created", text=f"Created from approved plan: {task.title}")
        # Insert edges after every task exists; proposal order need not be topological.
        for task in proposal.tasks:
            for prerequisite in task.dependencies:
                c.execute("INSERT INTO public.task_dependencies(project_id,task_id,depends_on_task_id) VALUES (%s,%s,%s)",
                          (project_id, ids[task.key], ids[prerequisite]))
        result = ApprovePlanResponse(projectId=project_id, projectVersion=project["version"],
                                     planId=plan_id, planVersion=revision["version"], taskIds=ids)
        c.execute("UPDATE public.operations SET response_payload=%s WHERE actor_id=%s AND operation_id=%s",
                  (Jsonb(result.model_dump(mode="json")), actor_id, request.operationId))
    return result


def generation_context(actor_id: UUID, project_id: UUID) -> dict:
    """Read bounded project metadata after checking owner access; no network under locks."""
    with _connect() as connection:
        _authorize(connection, actor_id, project_id, write=True)
        return connection.execute(
            "SELECT name, repository, left(description, 10000) AS description FROM public.projects WHERE id=%s",
            (project_id,),
        ).fetchone()
