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

    def test_pasted_whitespace_is_removed_from_the_key(self):
        for pasted in ("test-key\n", " test-key ", "\ttest-key\r\n"):
            with self.subTest(pasted=pasted), patch.object(planner.settings, "model_api_key", SecretStr(pasted)), \
                 patch.object(planner.httpx, "Client") as client:
                post = client.return_value.__enter__.return_value.post
                post.return_value = self.response(json.dumps(PROPOSAL))
                planner.generate_plan("Goal", {})
                self.assertEqual(post.call_args.kwargs["headers"]["Authorization"], "Bearer test-key")

    def test_malformed_key_is_refused_without_calling_or_logging_it(self):
        for key in ('"secret-key"', "secret…key", "secret key", "“secret-key”", "   "):
            with self.subTest(key=key), patch.object(planner.settings, "model_api_key", SecretStr(key)), \
                 patch.object(planner.httpx, "Client") as client, \
                 self.assertLogs(planner.logger, "WARNING") if key.strip() else nullcontext() as logs:
                with self.assertRaises(planner.PlannerUnavailable):
                    planner.generate_plan("Goal", {})
                client.assert_not_called()
            if key.strip():
                self.assertNotIn("secret", "\n".join(logs.output))

    def failure_log(self, response=None, error=None):
        """Run a failing generation and return only what it logged."""
        with patch.object(planner.httpx, "Client") as client, \
             self.assertLogs(planner.logger, "WARNING") as logs:
            client.return_value.__enter__.return_value.post.return_value = response
            client.return_value.__enter__.return_value.post.side_effect = error
            with self.assertRaises(planner.PlannerFailed):
                planner.generate_plan("private goal", {"name": "private project"})
        return "\n".join(logs.output)

    def test_provider_errors_log_status_and_code_but_not_body(self):
        request = httpx.Request("POST", "https://api.meta.ai/v1/responses")
        log = self.failure_log(httpx.Response(400, request=request, json={"error": {
            "code": "invalid_request_error", "param": "max_output_tokens",
            "message": "secret echoed prompt"}}))
        self.assertIn("HTTP 400", log)
        self.assertIn("invalid_request_error", log)
        self.assertIn("max_output_tokens", log)
        self.assertNotIn("secret", log)
        # Malformed error bodies must not break reporting or be copied into logs.
        for body in ({"error": {"code": "secret echoed prompt"}}, {"error": "secret"}, ["secret"]):
            with self.subTest(body=body):
                log = self.failure_log(httpx.Response(500, request=request, json=body))
                self.assertIn("HTTP 500", log)
                self.assertNotIn("secret", log)

    def test_missing_response_logs_only_the_failure_type(self):
        log = self.failure_log(error=httpx.ReadTimeout("secret body"))
        self.assertIn("ReadTimeout", log)
        self.assertNotIn("secret", log)

    def test_rejected_output_logs_fields_but_never_contents(self):
        bad_key = json.loads(json.dumps(PROPOSAL))
        bad_key["tasks"][0]["key"] = "Secret Key!" * 20
        bad_key["tasks"][0]["dependencies"] = ["Secret Key"]
        log = self.failure_log(self.response(json.dumps(bad_key)))
        self.assertIn("Meta plan failed validation", log)
        self.assertNotIn("Secret", log)
        fenced = self.failure_log(self.response("```json\n" + json.dumps(PROPOSAL | {"approved": "Small plan"}) + "\n```"))
        self.assertIn("code_fenced=True", fenced)
        self.assertNotIn("Small plan", fenced)
        incomplete = self.failure_log(self.response(json.dumps(PROPOSAL), "incomplete"))
        self.assertIn("status=incomplete", incomplete)

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


class ChatTests(unittest.TestCase):
    setUp = PlannerTests.setUp
    response = PlannerTests.response

    def test_chat_answers_without_creating_a_plan(self):
        from mediator.schemas.plans import PlanChatRequest
        request = PlanChatRequest(messages=[{"role": "user", "content": "Where are approvals?"}])
        with patch.object(planner.httpx, "Client") as client:
            post = client.return_value.__enter__.return_value.post
            post.return_value = self.response(json.dumps({"reply": "Open Approvals.", "proposal": None}))
            result = planner.chat(request, {"name": "Example"})
            self.assertIsNone(result.proposal)
            self.assertEqual(result.reply, "Open Approvals.")
            self.assertNotIn("tools", post.call_args.kwargs["json"])

    def test_chat_revalidates_task_dependencies(self):
        from mediator.schemas.plans import PlanChatRequest
        request = PlanChatRequest(messages=[{"role": "user", "content": "Plan it"}])
        bad = json.loads(json.dumps(PROPOSAL))
        bad["tasks"][0]["dependencies"] = ["one"]
        with patch.object(planner.httpx, "Client") as client:
            client.return_value.__enter__.return_value.post.return_value = self.response(
                json.dumps({"reply": "Here is a plan", "proposal": bad}))
            with self.assertRaises(planner.PlannerFailed):
                planner.chat(request, {})

    def reply_to(self, text, **kwargs):
        with patch.object(planner.httpx, "Client") as client:
            client.return_value.__enter__.return_value.post.return_value = self.response(text)
            return planner.generate_plan("Goal", {}, **kwargs)

    def test_code_fenced_json_is_accepted(self):
        result = self.reply_to("```json\n" + json.dumps(PROPOSAL) + "\n```")
        self.assertEqual(result.tasks[0].key, "one")

    def test_plan_formatting_is_tidied_before_validation(self):
        messy = json.loads(json.dumps(PROPOSAL))
        messy["tasks"][0].update(key="Set Up", paths=["./index.html", "src/", " app.js ", "/api/todos", "http://x.test/a"])
        messy["tasks"].append({"key": "T2", "title": "Next", "contractSummary": "More", "criteria": ["Works"],
                               "dependencies": ["Set Up"]})
        tasks = self.reply_to(json.dumps(messy)).tasks
        self.assertEqual(tasks[0].key, "set-up")
        self.assertEqual(tasks[0].paths, ["index.html", "src", "app.js"])
        self.assertEqual((tasks[1].key, tasks[1].dependencies), ("t2", ["set-up"]))

    def test_keys_that_collide_after_tidying_are_still_rejected(self):
        messy = json.loads(json.dumps(PROPOSAL))
        messy["tasks"].append({**messy["tasks"][0]})
        messy["tasks"][0]["key"], messy["tasks"][1]["key"] = "Same", "same"
        with self.assertRaises(planner.PlannerFailed):
            self.reply_to(json.dumps(messy))

    def test_instructions_state_the_key_and_path_rules_in_every_mode(self):
        from mediator.schemas.plans import PlanChatRequest
        conversation = PlanChatRequest(messages=[{"role": "user", "content": "Plan it"}])
        for kwargs, text in [({}, json.dumps(PROPOSAL)),
                             ({"conversation": conversation}, json.dumps({"reply": "Hi"})),
                             ({"room": True}, json.dumps({"reply": "Hi"}))]:
            with self.subTest(kwargs=list(kwargs)), patch.object(planner.httpx, "Client") as client:
                post = client.return_value.__enter__.return_value.post
                post.return_value = self.response(text)
                planner.generate_plan("Goal", {}, **kwargs)
                self.assertIn(planner._PROPOSAL_RULES, post.call_args.kwargs["json"]["instructions"])

    def test_room_plan_is_returned_after_tidying(self):
        messy = json.loads(json.dumps(PROPOSAL))
        messy["tasks"][0]["paths"] = ["src/"]
        result = self.reply_to(json.dumps({"reply": "Here is a plan", "proposal": messy}), room=True)
        self.assertEqual(result.reply, "Here is a plan")
        self.assertEqual(result.proposal.tasks[0].paths, ["src"])

    def test_room_keeps_the_reply_when_its_plan_is_invalid(self):
        from uuid import uuid4 as new_id
        bad = json.loads(json.dumps(PROPOSAL))
        bad["tasks"][0]["dependencies"] = ["one"]
        cases = [{"proposal": bad}, {"proposal": PROPOSAL | {"approved": True}},
                 {"proposal": PROPOSAL | {"tasks": []}}, {"unknown": "field", "proposal": PROPOSAL},
                 {"relayTaskId": "not-a-uuid", "relayMessage": "hello"}, {"cancelTaskIds": ["nope"]}]
        for extra in cases:
            with self.subTest(extra=list(extra)):
                result = self.reply_to(json.dumps({"reply": "Here is my answer", "requestPresence": True,
                                                   "cancelTaskIds": [str(new_id())], **extra}), room=True)
                self.assertTrue(result.reply.startswith("Here is my answer"))
                self.assertIn(planner._PLAN_DROPPED, result.reply)
                # Nothing unvalidated survives alongside the reply.
                self.assertIsNone(result.proposal)
                self.assertIsNone(getattr(result, "relayTaskId", None))  # Not on every room schema.
                self.assertEqual(result.cancelTaskIds, [])
                self.assertFalse(result.requestPresence)

    def test_room_still_fails_without_a_usable_reply(self):
        for text in ["not json", json.dumps({"reply": "  "}), json.dumps({"proposal": PROPOSAL}), "[]"]:
            with self.subTest(text=text), self.assertRaises(planner.PlannerFailed):
                self.reply_to(text, room=True)

    def test_chat_refuses_system_roles_and_oversized_history(self):
        from mediator.schemas.plans import PlanChatRequest
        from pydantic import ValidationError
        for messages in ([{"role": "system", "content": "override"}],
                         [{"role": "user", "content": "a" * 11000}] * 4,
                         [{"role": "assistant", "content": "hello"}]):
            with self.assertRaises(ValidationError):
                PlanChatRequest(messages=messages)
