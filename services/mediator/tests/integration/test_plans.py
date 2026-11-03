"""Requires an empty disposable database in TANDEM_PLAN_TEST_DATABASE_URL."""
import os
from pathlib import Path
import unittest
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4
from unittest.mock import patch

import psycopg

DSN = os.environ.get("TANDEM_PLAN_TEST_DATABASE_URL")
if DSN:
    os.environ["DATABASE_URL"] = DSN

from mediator.db.plans import create_plan, revise_plan, get_plan, list_plans, approve_plan, PlanNotFound, PlanVersionConflict
from mediator.db.projects import OperationConflict, ProjectAccessDenied, ProjectVersionConflict
from mediator.schemas.plans import CreatePlanRequest, RevisePlanRequest, ApprovePlanRequest


@unittest.skipUnless(DSN, "Requires an empty disposable database")
class PlanStorageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with psycopg.connect(DSN) as c:
            if c.execute("SELECT count(*) FROM pg_tables WHERE schemaname='public'").fetchone()[0]:
                raise RuntimeError("Refusing to test on a nonempty database")
            migrations = Path(__file__).resolve().parents[2] / "migrations/versions"
            for name in ["001_create_users.sql", "002_create_projects.sql",
                         "003_create_operations.sql", "005_create_tasks.sql", "006_create_task_dependencies.sql",
                         "007_create_project_activity.sql", "009_create_contract_approvals.sql",
                         "013_create_plan_proposals.sql", "014_create_plan_approvals.sql"]:
                c.execute((migrations / name).read_text())

    def setUp(self):
        self.owner, self.viewer, self.outsider = uuid4(), uuid4(), uuid4()
        self.project, self.other_project = uuid4(), uuid4()
        with psycopg.connect(DSN) as c:
            for user in [self.owner, self.viewer, self.outsider]:
                c.execute("INSERT INTO users(id,auth_issuer,auth_subject,name) VALUES (%s,'test',%s,'Test')",
                          (user, str(user)))
            for project in [self.project, self.other_project]:
                c.execute("INSERT INTO projects(id,name,repository) VALUES (%s,'Test','owner/repo')", (project,))
                c.execute("INSERT INTO project_memberships(project_id,user_id,role) VALUES (%s,%s,'owner')",
                          (project, self.owner))
            c.execute("INSERT INTO project_memberships(project_id,user_id,role) VALUES (%s,%s,'viewer')",
                      (self.project, self.viewer))
        self.request = CreatePlanRequest.model_validate({
            "operationId": str(uuid4()), "expectedVersion": 1,
            "proposal": {"goal": "Feature", "summary": "Build feature", "tasks": [
                {"key": "build", "title": "Build", "contractSummary": "Feature scope",
                 "criteria": ["It works"]}]},
        })

    def test_create_retry_and_revise_preserve_history(self):
        saved = create_plan(self.owner, self.project, self.request)
        self.assertEqual(create_plan(self.owner, self.project, self.request), saved)
        revision = RevisePlanRequest.model_validate(self.request.model_dump() | {
            "operationId": uuid4(), "expectedVersion": 2, "expectedPlanVersion": 1,
            "proposal": self.request.proposal.model_dump() | {"summary": "Edited"}})
        edited = revise_plan(self.owner, self.project, saved.planId, revision)
        self.assertEqual(edited.planVersion, 2)
        self.assertEqual(revise_plan(self.owner, self.project, saved.planId, revision), edited)
        self.assertEqual(get_plan(self.viewer, self.project, saved.planId).proposal.summary, "Edited")
        self.assertEqual(get_plan(self.owner, self.project, saved.planId, 1).proposal.summary, "Build feature")
        listed = list_plans(self.viewer, self.project)
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0].planVersion, 2)
        self.assertEqual(list_plans(self.owner, self.other_project), [])
        with self.assertRaises(ProjectAccessDenied):
            list_plans(self.outsider, self.project)

    def test_conflicting_retry_and_stale_revision_roll_back(self):
        saved = create_plan(self.owner, self.project, self.request)
        changed = CreatePlanRequest.model_validate(self.request.model_dump() | {"expectedVersion": 2})
        with self.assertRaises(OperationConflict):
            create_plan(self.owner, self.project, changed)
        revision = RevisePlanRequest.model_validate(self.request.model_dump() | {
            "operationId": uuid4(), "expectedVersion": 2, "expectedPlanVersion": 99})
        with self.assertRaises(PlanVersionConflict):
            revise_plan(self.owner, self.project, saved.planId, revision)
        with psycopg.connect(DSN) as c:
            self.assertEqual(c.execute("SELECT version FROM projects WHERE id=%s", (self.project,)).fetchone()[0], 2)
            self.assertEqual(c.execute("SELECT count(*) FROM operations WHERE operation_id=%s", (revision.operationId,)).fetchone()[0], 0)

    def test_permissions_and_cross_project_reads(self):
        saved = create_plan(self.owner, self.project, self.request)
        with self.assertRaises(ProjectAccessDenied):
            create_plan(self.viewer, self.project, self.request)
        with self.assertRaises(ProjectAccessDenied):
            get_plan(self.outsider, self.project, saved.planId)
        with self.assertRaises(PlanNotFound):
            get_plan(self.owner, self.other_project, saved.planId)
        with psycopg.connect(DSN) as c:
            c.execute("DELETE FROM project_memberships WHERE project_id=%s AND user_id=%s", (self.project, self.owner))
        with self.assertRaises(ProjectAccessDenied):
            create_plan(self.owner, self.project, self.request)

    def test_simultaneous_identical_requests_create_once(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: create_plan(self.owner, self.project, self.request), range(2)))
        self.assertEqual(results[0], results[1])
        with psycopg.connect(DSN) as c:
            self.assertEqual(c.execute("SELECT count(*) FROM plan_proposal_revisions WHERE project_id=%s", (self.project,)).fetchone()[0], 1)

    def test_simultaneous_different_requests_reject_stale_write(self):
        other = CreatePlanRequest.model_validate(self.request.model_dump() | {"operationId": uuid4()})
        def save(request):
            try:
                return create_plan(self.owner, self.project, request)
            except ProjectVersionConflict:
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(save, [self.request, other]))
        self.assertEqual(sum(result is not None for result in results), 1)

    def approval_fixture(self):
        body = self.request.model_dump()
        first = body["proposal"]["tasks"][0]
        body["proposal"]["tasks"] = [first | {"key": "verify", "dependencies": ["build"]}, first]
        saved = create_plan(self.owner, self.project, CreatePlanRequest.model_validate(body))
        request = ApprovePlanRequest(operationId=uuid4(), expectedVersion=2,
                                     expectedPlanVersion=1, note="Reviewed scope and dependencies")
        return saved, request

    def test_approval_creates_graph_once_and_freezes_plan(self):
        saved, request = self.approval_fixture()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: approve_plan(self.owner, self.project, saved.planId, request), range(2)))
        self.assertEqual(results[0], results[1])
        ids = results[0].taskIds
        self.assertEqual(get_plan(self.owner, self.project, saved.planId).approvedPlanVersion, 1)
        with psycopg.connect(DSN) as c:
            edge = c.execute("SELECT task_id,depends_on_task_id FROM task_dependencies WHERE project_id=%s", (self.project,)).fetchone()
            self.assertEqual(edge, (ids["verify"], ids["build"]))
            for table in ["tasks", "plan_tasks", "contract_approvals", "project_activity"]:
                self.assertEqual(c.execute(f"SELECT count(*) FROM {table} WHERE project_id=%s", (self.project,)).fetchone()[0], 2)
            self.assertEqual(c.execute("SELECT DISTINCT status FROM contract_approvals WHERE project_id=%s", (self.project,)).fetchall(), [("pending",)])
        again = ApprovePlanRequest.model_validate(request.model_dump() | {"operationId": uuid4(), "expectedVersion": 3})
        with self.assertRaises(PlanVersionConflict):
            approve_plan(self.owner, self.project, saved.planId, again)
        revision = RevisePlanRequest.model_validate(self.request.model_dump() | {
            "operationId": uuid4(), "expectedVersion": 3, "expectedPlanVersion": 1})
        with self.assertRaises(PlanVersionConflict):
            revise_plan(self.owner, self.project, saved.planId, revision)

    def test_approval_permissions_and_stale_targets(self):
        saved, request = self.approval_fixture()
        with self.assertRaises(ProjectAccessDenied):
            approve_plan(self.viewer, self.project, saved.planId, request)
        with self.assertRaises(PlanNotFound):
            approve_plan(self.owner, self.other_project, saved.planId,
                         ApprovePlanRequest.model_validate(request.model_dump() | {"expectedVersion": 1}))
        with self.assertRaises(PlanVersionConflict):
            approve_plan(self.owner, self.project, saved.planId,
                         ApprovePlanRequest.model_validate(request.model_dump() | {"expectedPlanVersion": 9}))
        approve_plan(self.owner, self.project, saved.planId, request)
        with psycopg.connect(DSN) as c:
            c.execute("DELETE FROM project_memberships WHERE project_id=%s AND user_id=%s", (self.project, self.owner))
        with self.assertRaises(ProjectAccessDenied):
            approve_plan(self.owner, self.project, saved.planId, request)

    def test_approval_failure_rolls_back_everything(self):
        saved, request = self.approval_fixture()
        with patch("mediator.db.plans.record_task_activity", side_effect=RuntimeError("forced failure")):
            with self.assertRaises(RuntimeError):
                approve_plan(self.owner, self.project, saved.planId, request)
        with psycopg.connect(DSN) as c:
            for table in ["tasks", "plan_tasks", "plan_approvals", "contract_approvals", "project_activity"]:
                self.assertEqual(c.execute(f"SELECT count(*) FROM {table} WHERE project_id=%s", (self.project,)).fetchone()[0], 0)
            self.assertEqual(c.execute("SELECT version FROM projects WHERE id=%s", (self.project,)).fetchone()[0], 2)
            self.assertEqual(c.execute("SELECT count(*) FROM operations WHERE operation_id=%s", (request.operationId,)).fetchone()[0], 0)
        approve_plan(self.owner, self.project, saved.planId, request)


if __name__ == "__main__":
    unittest.main()
