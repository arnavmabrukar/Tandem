"""Exercise the review and release routes without a database or Auth0."""
import logging
import unittest
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient
from psycopg import OperationalError

from mediator.db import agent_tasks
from mediator.db.projects import OperationConflict, ProjectAccessDenied, ProjectVersionConflict
from mediator.main import app, get_current_user


class TaskDecisionRouteTests(unittest.TestCase):
    def setUp(self):
        logging.disable(logging.INFO)
        self.addCleanup(logging.disable, logging.NOTSET)
        self.actor, self.project, self.task, self.operation = (str(uuid4()) for _ in range(4))
        original = app.dependency_overrides.copy()
        self.addCleanup(lambda: setattr(app, "dependency_overrides", original))
        app.dependency_overrides[get_current_user] = lambda: {"id": self.actor}
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.reply = {"projectId": self.project, "projectVersion": 2, "entityId": self.task,
                      "taskVersion": 3, "status": "approved"}

    def post(self, action, body=None, key=None):
        payload = {"operationId": self.operation, "expectedVersion": 1, **(body or {})}
        return self.client.post(f"/api/projects/{self.project}/tasks/{self.task}/{action}", json=payload,
                                headers={"Idempotency-Key": key or self.operation})

    def test_accept_uses_the_authenticated_actor(self):
        with patch("mediator.main.save_task_review", return_value=self.reply) as save:
            response = self.post("review", {"decision": "accept"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(str(save.call_args.args[0]), self.actor)

    def test_invalid_or_forged_requests_never_reach_the_database(self):
        cases = (
            ("review", {"decision": "merged"}),
            ("review", {"decision": "request_changes"}),
            ("review", {"decision": "request_changes", "note": "   "}),
            ("review", {"decision": "accept", "actorId": self.actor}),
            ("release", {"status": "approved"}),
        )
        for action, body in cases:
            with self.subTest(action=action, body=body), \
                 patch("mediator.main.save_task_review") as review, patch("mediator.main.save_task_release") as release:
                self.assertEqual(self.post(action, body).status_code, 422)
                review.assert_not_called()
                release.assert_not_called()

    def test_mismatched_retry_id_never_reaches_the_database(self):
        with patch("mediator.main.save_task_release") as release:
            self.assertEqual(self.post("release", key=str(uuid4())).status_code, 400)
            release.assert_not_called()

    def test_errors_are_mapped_without_database_details(self):
        cases = ((ProjectAccessDenied(), 403), (agent_tasks.AgentTaskNotFound("x"), 404),
                 (OperationConflict(), 409), (ProjectVersionConflict(), 409),
                 (agent_tasks.AgentTaskConflict("Task is open"), 409),
                 (OperationalError("secret-password"), 503))
        for error, status in cases:
            with self.subTest(status=status), patch("mediator.main.save_task_release", side_effect=error):
                response = self.post("release")
                self.assertEqual(response.status_code, status)
                self.assertNotIn("secret-password", response.text)

    def test_approve_and_run_needs_the_dispatcher(self):
        body = {"operationId": self.operation, "expectedVersion": 1, "expectedPlanVersion": 1,
                "note": "Reviewed", "startNow": True}
        with patch("mediator.main.settings.dispatch_enabled", False), \
             patch("mediator.main.approve_saved_plan") as approve:
            response = self.client.post(f"/api/projects/{self.project}/plans/{uuid4()}/approve", json=body,
                                        headers={"Idempotency-Key": self.operation})
        self.assertEqual(response.status_code, 503)
        approve.assert_not_called()


if __name__ == "__main__":
    unittest.main()
