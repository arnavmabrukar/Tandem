"""Verify the HTTP boundary; database transactions have integration tests."""
import unittest
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient
from psycopg import OperationalError

from mediator.main import app, get_current_user
from mediator.db.plans import PlanNotFound, PlanVersionConflict
from mediator.db.projects import ProjectAccessDenied, ProjectVersionConflict, OperationConflict


class PlanRouteTests(unittest.TestCase):
    def setUp(self):
        self.actor, self.project, self.plan = uuid4(), uuid4(), uuid4()
        self.url = f"/api/projects/{self.project}/plans"
        self.body = {"operationId": str(uuid4()), "expectedVersion": 1,
                     "proposal": {"goal": "Build", "summary": "Build feature", "tasks": [
                         {"key": "build", "title": "Build", "contractSummary": "Scope",
                          "criteria": ["It works"]}]}}
        self.result = {"projectId": str(self.project), "projectVersion": 2,
                       "planId": str(self.plan), "planVersion": 1}
        original = app.dependency_overrides.copy()
        self.addCleanup(lambda: setattr(app, "dependency_overrides", original))
        app.dependency_overrides[get_current_user] = lambda: {"id": str(self.actor)}
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def post(self, suffix="", body=None, key=None):
        return self.client.post(self.url + suffix, json=body or self.body,
                                headers={"Idempotency-Key": key or self.body["operationId"]})

    def test_create_and_revision_use_authenticated_identity(self):
        with patch("mediator.main.save_plan", return_value=self.result) as save:
            response = self.post()
            self.assertEqual(response.status_code, 201, response.text)
            self.assertEqual(response.json(), self.result)
            self.assertEqual(save.call_args.kwargs["actor_id"], self.actor)

            self.assertEqual(save.call_args.kwargs["project_id"], self.project)
        with patch("mediator.main.save_plan_revision", return_value=self.result) as save:
            response = self.post(f"/{self.plan}/revisions", self.body | {"expectedPlanVersion": 1})
            self.assertEqual(response.status_code, 201, response.text)
            self.assertEqual(save.call_args.kwargs["plan_id"], self.plan)
            self.assertEqual(save.call_args.kwargs["actor_id"], self.actor)

    def test_approve_boundary(self):
        body = {"operationId": self.body["operationId"], "expectedVersion": 2,
                "expectedPlanVersion": 1, "note": "Reviewed"}
        with patch("mediator.main.approve_saved_plan", return_value=self.result | {"taskIds": {}}) as approve:
            response = self.post(f"/{self.plan}/approve", body)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(approve.call_args.kwargs["actor_id"], self.actor)
            approve.reset_mock()
            self.assertEqual(self.post(f"/{self.plan}/approve", body, str(uuid4())).status_code, 400)
            self.assertEqual(self.post(f"/{self.plan}/approve", body | {"note": " "}).status_code, 422)
            approve.assert_not_called()
            app.dependency_overrides.pop(get_current_user)
            self.assertEqual(self.post(f"/{self.plan}/approve", body).status_code, 401)
            approve.assert_not_called()

    def test_latest_and_historical_reads(self):
        result = self.result | {"createdBy": str(self.actor), "createdAt": "2026-11-02T12:00:00Z",
                                "proposal": self.body["proposal"]}
        with patch("mediator.main.load_plans", return_value=[result]) as load:
            response = self.client.get(self.url)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(len(response.json()), 1)
            self.assertEqual(load.call_args.kwargs["actor_id"], self.actor)
            self.assertEqual(load.call_args.kwargs["project_id"], self.project)
        with patch("mediator.main.load_plan", return_value=result) as load:
            for query, version in [("", None), ("?version=1", 1)]:
                response = self.client.get(f"{self.url}/{self.plan}{query}")
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(load.call_args.kwargs["version"], version)
                self.assertEqual(load.call_args.kwargs["actor_id"], self.actor)
            load.reset_mock()
            self.assertEqual(self.client.get(f"{self.url}/{self.plan}?version=0").status_code, 422)
            load.assert_not_called()

    def test_invalid_requests_never_reach_storage(self):
        for target, suffix, body in [
            ("save_plan", "", self.body),
            ("save_plan_revision", f"/{self.plan}/revisions", self.body | {"expectedPlanVersion": 1}),
        ]:
            with patch(f"mediator.main.{target}") as save:
                self.assertEqual(self.post(suffix, body, str(uuid4())).status_code, 400)
                self.assertEqual(self.post(suffix, body | {"created_by": str(self.actor)}).status_code, 422)
                self.assertEqual(self.client.post(self.url + suffix, json=body).status_code, 422)
                save.assert_not_called()

    def test_domain_errors_and_database_privacy(self):
        for target, action in [
            ("save_plan", lambda: self.post()),
            ("save_plan_revision", lambda: self.post(f"/{self.plan}/revisions", self.body | {"expectedPlanVersion": 1})),
            ("load_plan", lambda: self.client.get(f"{self.url}/{self.plan}")),
        ]:
            for error, status in [(ProjectAccessDenied(), 403), (PlanNotFound(), 404),
                                  (OperationConflict(), 409), (ProjectVersionConflict(), 409),
                                  (PlanVersionConflict(), 409), (OperationalError("secret-password"), 503)]:
                with self.subTest(target=target, status=status), patch(f"mediator.main.{target}", side_effect=error):
                    response = action()
                    self.assertEqual(response.status_code, status, response.text)
                    self.assertNotIn("secret-password", response.text)

    def test_all_routes_require_authentication(self):
        app.dependency_overrides.pop(get_current_user)
        with patch("mediator.main.load_plans") as listing:
            self.assertEqual(self.client.get(self.url).status_code, 401)
            listing.assert_not_called()
        with patch("mediator.main.save_plan") as create, patch("mediator.main.save_plan_revision") as revise, patch("mediator.main.load_plan") as load:
            self.assertEqual(self.post().status_code, 401)
            self.assertEqual(self.post(f"/{self.plan}/revisions", self.body | {"expectedPlanVersion": 1}).status_code, 401)
            self.assertEqual(self.client.get(f"{self.url}/{self.plan}").status_code, 401)
            create.assert_not_called()
            revise.assert_not_called()
            load.assert_not_called()
