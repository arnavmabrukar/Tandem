"""Exercise the MCP tool boundary and presence without using a real database."""
import logging
import unittest
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient
from psycopg import OperationalError

from mediator.db.agent_tasks import (
    AgentClaimBlocked,
    AgentTaskConflict,
    claim_blockers,
)
from mediator.main import app
from mediator.mcp.server import mcp

PROJECT_ID = str(uuid4())
OTHER_PROJECT_ID = str(uuid4())
TASK_ID = str(uuid4())
IDENTITY = {
    "agentId": "agent-test", "ownerId": str(uuid4()), "name": "Test agent", "client": "Codex",
    "projects": [{"projectId": PROJECT_ID, "name": "Test", "ownerRole": "owner"}],
}


class ToolTestCase(unittest.TestCase):
    def setUp(self):
        logging.disable(logging.INFO)
        self.addCleanup(logging.disable, logging.NOTSET)
        for target, name in (("verify_agent_token", "verify"), ("record_agent_seen", "seen")):
            patcher = patch(f"mediator.mcp.auth.{target}")
            setattr(self, name, patcher.start())
            self.addCleanup(patcher.stop)
        self.verify.return_value = IDENTITY
        # The SDK's session manager normally starts once per process.
        mcp.session_manager._has_started = False
        self.client = TestClient(app, base_url="http://127.0.0.1:8000")
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)

    def request(self, method, params=None):
        return self.client.post("/mcp/", headers={
            "Authorization": "Bearer test-secret",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-03-26",
        }, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}})

    def call(self, name, **arguments):
        response = self.request("tools/call", {"name": name, "arguments": arguments})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["result"]

    def assert_refused(self, result, text=None):
        self.assertTrue(result.get("isError"), result)
        if text:
            self.assertIn(text, result["content"][0]["text"])


class ProjectScopeTests(ToolTestCase):
    def test_all_project_tools_are_registered(self):
        names = {tool["name"] for tool in self.request("tools/list").json()["result"]["tools"]}
        self.assertLessEqual({"tandem_list_tasks", "tandem_get_task", "tandem_claim_task",
                              "tandem_update_task", "tandem_post_message"}, names)

    def test_other_projects_are_refused_before_reaching_database(self):
        calls = (
            ("tandem_list_tasks", {}, "list_tasks"),
            ("tandem_get_task", {"taskId": TASK_ID}, "get_task"),
            ("tandem_claim_task", {"taskId": TASK_ID, "expectedVersion": 1,
                                   "operationId": str(uuid4())}, "claim_task"),
            ("tandem_update_task", {"taskId": TASK_ID, "expectedVersion": 1,
                                    "operationId": str(uuid4()), "progress": "Working"}, "update_task"),
            ("tandem_post_message", {"taskId": TASK_ID, "type": "status", "body": "Hello",
                                      "operationId": str(uuid4())}, "post_message"),
        )
        for tool, arguments, function in calls:
            with self.subTest(tool=tool), patch(f"mediator.db.agent_tasks.{function}") as database:
                self.assert_refused(self.call(tool, projectId=OTHER_PROJECT_ID, **arguments),
                                    "does not have access")
                database.assert_not_called()


class HumanOnlyActionTests(ToolTestCase):
    def test_agents_cannot_request_human_only_statuses(self):
        for status in ("approved", "merged", "cancelled", "open", "claimed"):
            with self.subTest(status=status), patch("mediator.db.agent_tasks.update_task") as database:
                self.assert_refused(self.call(
                    "tandem_update_task", projectId=PROJECT_ID, taskId=TASK_ID,
                    expectedVersion=1, operationId=str(uuid4()), status=status,
                ))
                database.assert_not_called()

    def test_agents_cannot_post_human_notes_or_blank_messages(self):
        for message_type, body in (("human_note", "Hello"), ("status", "   "), ("status", "a\x00b")):
            with self.subTest(type=message_type, body=body), \
                 patch("mediator.db.agent_tasks.post_message") as database:
                self.assert_refused(self.call(
                    "tandem_post_message", projectId=PROJECT_ID, taskId=TASK_ID,
                    type=message_type, body=body, operationId=str(uuid4()),
                ))
                database.assert_not_called()

    def test_identity_comes_from_authentication(self):
        with patch("mediator.db.agent_tasks.claim_task", return_value={"status": "claimed"}) as database:
            result = self.call("tandem_claim_task", projectId=PROJECT_ID, taskId=TASK_ID,
                               expectedVersion=1, operationId=str(uuid4()))
        self.assertFalse(result.get("isError"), result)
        self.assertEqual(database.call_args.args[0], IDENTITY)


class ErrorMappingTests(ToolTestCase):
    def test_refusals_explain_and_database_errors_stay_private(self):
        arguments = dict(projectId=PROJECT_ID, taskId=TASK_ID, expectedVersion=1,
                         operationId=str(uuid4()))
        with patch("mediator.db.agent_tasks.claim_task",
                   side_effect=AgentClaimBlocked("Contract is waiting for human approval")):
            self.assert_refused(self.call("tandem_claim_task", **arguments), "waiting for human approval")
        with patch("mediator.db.agent_tasks.claim_task",
                   side_effect=AgentTaskConflict("Task changed")):
            self.assert_refused(self.call("tandem_claim_task", **arguments), "Task changed")
        with patch("mediator.db.agent_tasks.claim_task",
                   side_effect=OperationalError("secret-password")):
            result = self.call("tandem_claim_task", **arguments)
            self.assert_refused(result, "retry shortly")
            self.assertNotIn("secret-password", str(result))


class PresenceTests(ToolTestCase):
    def test_authenticated_request_records_a_check_in(self):
        self.call("tandem_status")
        self.seen.assert_called_once_with("agent-test")

    def test_failed_authentication_records_nothing(self):
        self.verify.return_value = None
        self.assertEqual(self.request("tools/list").status_code, 401)
        self.seen.assert_not_called()

    def test_check_in_failure_does_not_fail_the_request(self):
        self.seen.side_effect = OperationalError("secret-password")
        result = self.call("tandem_status")
        self.assertFalse(result.get("isError"), result)
        self.assertEqual(result["structuredContent"]["status"], "ok")


class ClaimBlockerTests(unittest.TestCase):
    def task(self, **changes):
        return {"status": "open", "contract_review": "approved", "dependencies": [], **changes}

    def test_open_task_with_approved_contract_can_be_claimed(self):
        self.assertEqual(claim_blockers(self.task()), [])
        for status in ("approved", "merged"):
            self.assertEqual(claim_blockers(self.task(dependencies=[
                {"title": "First", "status": status}])), [])

    def test_contract_must_be_approved(self):
        for review, text in (("pending", "waiting"), ("rejected", "rejected"),
                             ("stale", "no approved"), (None, "no approved")):
            with self.subTest(review=review):
                blockers = claim_blockers(self.task(contract_review=review))
                self.assertEqual(len(blockers), 1)
                self.assertIn(text, blockers[0])

    def test_unfinished_dependencies_block_and_are_named(self):
        for status in ("open", "claimed", "in_progress", "in_review", "blocked", "cancelled"):
            with self.subTest(status=status):
                blockers = claim_blockers(self.task(dependencies=[{"title": "First", "status": status}]))
                self.assertEqual(len(blockers), 1)
                self.assertIn("First", blockers[0])

    def test_every_reason_is_reported_together(self):
        blockers = claim_blockers(self.task(status="claimed", contract_review="pending",
                                            dependencies=[{"title": "First", "status": "open"}]))
        self.assertEqual(len(blockers), 3)


if __name__ == "__main__":
    unittest.main()
