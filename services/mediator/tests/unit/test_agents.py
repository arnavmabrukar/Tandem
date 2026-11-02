"""Check registration's HTTP boundary without contacting Auth0 or Neon."""
import unittest
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient
from psycopg import OperationalError

from mediator.main import app, get_current_user
from mediator.db.agents import AgentNameConflict
from mediator.db.projects import OperationConflict, ProjectAccessDenied, ProjectVersionConflict


class AgentRouteTests(unittest.TestCase):
    def setUp(self):
        self.actor_id = str(uuid4())
        self.project_id = str(uuid4())
        self.operation_id = str(uuid4())
        self.url = f"/api/projects/{self.project_id}/agents"
        self.body = {
            "operationId": self.operation_id, "expectedVersion": 3,
            "name": "My Codex", "client": "Codex", "owner": "Untrusted label",
            "machine": "Laptop", "capabilities": ["Python"],
        }
        original = app.dependency_overrides.copy()
        self.addCleanup(lambda: setattr(app, "dependency_overrides", original))
        app.dependency_overrides[get_current_user] = lambda: {"id": self.actor_id}
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def post(self, key=None):
        return self.client.post(self.url, json=self.body,
                                headers={"Idempotency-Key": key or self.operation_id})

    def test_authenticated_actor_and_response(self):
        result = {"projectId": self.project_id, "projectVersion": 4, "entityId": str(uuid4())}
        with patch("mediator.main.save_agent", return_value=result) as save:
            response = self.post()
            self.assertEqual(response.status_code, 201)
            self.assertEqual(response.json(), result)
            self.assertEqual(str(save.call_args.kwargs["actor_id"]), self.actor_id)
            self.assertEqual(str(save.call_args.kwargs["project_id"]), self.project_id)

    def test_mismatched_key_never_calls_database(self):
        with patch("mediator.main.save_agent") as save:
            self.assertEqual(self.post(str(uuid4())).status_code, 400)
            save.assert_not_called()

    def test_forged_fields_and_invalid_values_are_rejected(self):
        for field, value in (("owner_user_id", self.actor_id), ("grant_status", "active"),
                             ("name", " "), ("expectedVersion", True)):
            with self.subTest(field=field), patch("mediator.main.save_agent") as save:
                original = self.body.copy()
                self.body[field] = value
                self.assertEqual(self.post().status_code, 422)
                save.assert_not_called()
                self.body = original

    def test_domain_errors_and_database_error_privacy(self):
        for error, status in ((ProjectAccessDenied(), 403),
                              (OperationConflict("Different request"), 409),
                              (ProjectVersionConflict("Reload"), 409),
                              (AgentNameConflict("Name unavailable"), 409),
                              (OperationalError("secret-password"), 503)):
            with self.subTest(status=status), patch("mediator.main.save_agent", side_effect=error):
                response = self.post()
                self.assertEqual(response.status_code, status)
                self.assertNotIn("secret-password", response.text)

    def test_unauthenticated_request_is_rejected(self):
        # Use the real authentication dependency: no bearer token is supplied.
        app.dependency_overrides.pop(get_current_user)
        with patch("mediator.main.save_agent") as save:
            self.assertEqual(self.post().status_code, 401)
            save.assert_not_called()
