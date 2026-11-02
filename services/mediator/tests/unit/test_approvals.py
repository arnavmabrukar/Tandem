"""Exercise the HTTP boundary without database writes or Auth0 requests."""
import unittest
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient
from psycopg import OperationalError

from mediator.main import app, get_current_user
from mediator.db.approvals import ApprovalConflict, ApprovalNotFound
from mediator.db.projects import ProjectAccessDenied


class ApprovalRouteTests(unittest.TestCase):
    def setUp(self):
        self.actor_id = str(uuid4())
        self.project_id = str(uuid4())
        self.approval_id = str(uuid4())
        self.operation_id = str(uuid4())
        self.url = f"/api/projects/{self.project_id}/approvals/{self.approval_id}/decisions"
        self.body = {
            "operationId": self.operation_id, "expectedVersion": 3,
            "decision": "approved", "note": "Reviewed the requirements",
            "target": {"action": "Approve contract", "repository": "owner/repo",
                       "taskVersion": 1, "contractVersion": 1, "head": None},
        }
        original = app.dependency_overrides.copy()
        self.addCleanup(lambda: setattr(app, "dependency_overrides", original))
        app.dependency_overrides[get_current_user] = lambda: {"id": self.actor_id}
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def post(self, key=None):
        return self.client.post(self.url, json=self.body,
                                headers={"Idempotency-Key": key or self.operation_id})

    def test_mismatched_retry_id_never_reaches_database(self):
        with patch("mediator.main.decide_contract") as save:
            self.assertEqual(self.post(str(uuid4())).status_code, 400)
            save.assert_not_called()

    def test_invalid_or_forged_request_never_reaches_database(self):
        for field, value in (("note", "   "), ("decision", "merged"), ("actor_id", self.actor_id)):
            with self.subTest(field=field), patch("mediator.main.decide_contract") as save:
                original = self.body.copy()
                self.body[field] = value
                self.assertEqual(self.post().status_code, 422)
                save.assert_not_called()
                self.body = original

    def test_errors_are_mapped_without_database_details(self):
        for error, status in ((ProjectAccessDenied(), 403), (ApprovalNotFound(), 404),
                              (ApprovalConflict("Review target changed"), 409),
                              (OperationalError("secret-password"), 503)):
            with self.subTest(status=status), patch("mediator.main.decide_contract", side_effect=error):
                response = self.post()
                self.assertEqual(response.status_code, status)
                self.assertNotIn("secret-password", response.text)

    def test_both_decisions_use_authenticated_actor(self):
        result = {"projectId": self.project_id, "projectVersion": 4, "entityId": self.approval_id}
        for decision in ("approved", "rejected"):
            self.body["decision"] = decision
            with patch("mediator.main.decide_contract", return_value=result) as save:
                self.assertEqual(self.post().json(), result)
                self.assertEqual(str(save.call_args.args[0]), self.actor_id)
                self.assertEqual(save.call_args.args[3].decision, decision)
