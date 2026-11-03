"""Model responses are untrusted; tests never make a paid network call."""
from contextlib import nullcontext
import json
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx
from pydantic import SecretStr
from fastapi.testclient import TestClient
from mediator import meta_planner as planner
from mediator.main import app, get_current_user
from mediator.db.projects import ProjectAccessDenied

PROPOSAL = {"goal": "Model goal", "summary": "Small plan", "tasks": [
    {"key": "one", "title": "Build", "contractSummary": "Small scope", "criteria": ["Works"]}]}


class PlannerTests(unittest.TestCase):
    def setUp(self):
        self.key = patch.object(planner.settings, "model_api_key", SecretStr("test-secret"))
        self.key.start()
        self.addCleanup(self.key.stop)

    def response(self, text, status="completed"):
        return httpx.Response(200, request=httpx.Request("POST", "https://api.meta.ai/v1/responses"),
            json={"status": status, "output": [{"type": "message", "role": "assistant",
                   "content": [{"type": "output_text", "text": text}]}]})

    def test_valid_response_preserves_human_goal_and_no_tools(self):
        with patch.object(planner.httpx, "Client") as client:
            post = client.return_value.__enter__.return_value.post
            post.return_value = self.response(json.dumps(PROPOSAL))
            result = planner.generate_plan("Human goal", {"name": "Project"})
            self.assertEqual(result.goal, "Human goal")
            payload = post.call_args.kwargs["json"]
            self.assertFalse(payload["stream"])
            self.assertFalse(payload["store"])
            self.assertNotIn("tools", payload)
            self.assertNotIn("test-secret", json.dumps(payload))
            post.assert_called_once()

    def test_invalid_incomplete_or_authoritative_output_rejected(self):
        cycle = json.loads(json.dumps(PROPOSAL))
        cycle["tasks"][0]["dependencies"] = ["one"]
        for text, status in [("not json", "completed"), (json.dumps(PROPOSAL), "incomplete"),
                             (json.dumps(cycle), "completed"),
                             (json.dumps(PROPOSAL | {"approved": True}), "completed")]:
            with self.subTest(text=text), patch.object(planner.httpx, "Client") as client:
                client.return_value.__enter__.return_value.post.return_value = self.response(text, status)
                with self.assertRaises(planner.PlannerFailed):
                    planner.generate_plan("Goal", {})

    def test_unconfigured_and_upstream_errors_are_private(self):
        with patch.object(planner.settings, "model_api_key", None), patch.object(planner.httpx, "Client") as client:
            with self.assertRaises(planner.PlannerUnavailable):
                planner.generate_plan("Goal", {})
            client.assert_not_called()
        with patch.object(planner.httpx, "Client") as client:
            client.return_value.__enter__.return_value.post.side_effect = httpx.ReadTimeout("secret body")
            with self.assertRaises(planner.PlannerFailed) as error:
                planner.generate_plan("Goal", {})
            self.assertNotIn("secret", str(error.exception))

    def test_route_authorizes_before_and_after_model_without_saving(self):
        actor, project = uuid4(), uuid4()
        old = app.dependency_overrides.copy()
        self.addCleanup(lambda: setattr(app, "dependency_overrides", old))
        app.dependency_overrides[get_current_user] = lambda: {"id": str(actor)}
        client = TestClient(app, raise_server_exceptions=False)
        self.addCleanup(client.close)
        with nullcontext(client) as client:
            with patch("mediator.main.generation_context", return_value={}) as context, \
                 patch("mediator.main.generate_meta_plan", return_value=PROPOSAL) as generate, \
                 patch("mediator.main.save_plan") as save:
                url = f"/api/projects/{project}/plans/generate"
                self.assertEqual(client.post(url, json={"goal": "Goal"}).status_code, 200)
                self.assertEqual(context.call_count, 2)
                save.assert_not_called()
                context.side_effect = ProjectAccessDenied()
                generate.reset_mock()
                self.assertEqual(client.post(url, json={"goal": "Goal"}).status_code, 403)
                generate.assert_not_called()
                context.side_effect = [{}, ProjectAccessDenied()]
                self.assertEqual(client.post(url, json={"goal": "Goal"}).status_code, 403)
                self.assertEqual(client.post(url, json={"goal": "   "}).status_code, 422)
