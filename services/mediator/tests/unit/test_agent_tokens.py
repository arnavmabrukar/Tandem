"""Verify token secrecy and retry behavior without touching Neon."""
import hashlib
import unittest
from unittest.mock import MagicMock, patch
from uuid import uuid4

from pydantic import SecretStr

from mediator.db.agents import issue_agent_token, AgentTokenConflict, AgentNotFound
from mediator.schemas.agents import IssueAgentTokenRequest


class AgentTokenTests(unittest.TestCase):
    def setUp(self):
        self.actor = uuid4()
        self.project = uuid4()
        self.agent = str(uuid4())
        self.request = IssueAgentTokenRequest(operationId=uuid4(), expectedVersion=1)
        self.connection = MagicMock()
        self.connection.__enter__.return_value = self.connection

    def issue(self, rows):
        # SET TRANSACTION has no result; each subsequent SELECT/RETURNING
        # consumes one mocked row. UPDATEs without RETURNING consume none.
        self.connection.execute.return_value.fetchone.side_effect = rows
        with patch("mediator.db.agents.psycopg.connect", return_value=self.connection), \
             patch("mediator.db.agents.settings") as settings:
            settings.database_url = SecretStr("postgresql://unused")
            return issue_agent_token(self.actor, self.project, self.agent, self.request)

    def test_only_hash_and_nonsecret_metadata_are_persisted(self):
        result = self.issue([{"operation_id": self.request.operationId}, {"role": "owner"},
                             {"version": 2}, {"grant_status": "pending", "status": "pending"}])
        self.assertTrue(result.token.startswith("tdm_"))
        self.assertNotIn(result.token, repr(result))
        calls = self.connection.execute.call_args_list
        token_update = next(call for call in calls if "SET token_hash" in call.args[0])
        self.assertEqual(token_update.args[1][0], hashlib.sha256(result.token.encode()).hexdigest())
        saved = next(call for call in calls if "SET response_payload" in call.args[0])
        self.assertNotIn("token", saved.args[1][0].obj)
        for call in calls:
            self.assertNotIn(result.token, repr(call))

    def test_completed_retry_does_not_rotate(self):
        payload = {"projectId": str(self.project), "agentId": self.agent,
                   **self.request.model_dump(mode="json")}
        with self.assertRaises(AgentTokenConflict):
            self.issue([None, {"role": "owner"},
                        {"operation_type": "issue_agent_token", "request_payload": payload}])
        self.assertFalse(any("SET token_hash" in call.args[0]
                             for call in self.connection.execute.call_args_list))

    def test_missing_or_revoked_agent_does_not_issue(self):
        for row, error in ((None, AgentNotFound),
                           ({"grant_status": "revoked", "status": "active"}, AgentTokenConflict),
                           ({"grant_status": "active", "status": "revoked"}, AgentTokenConflict)):
            with self.subTest(row=row):
                self.connection.reset_mock()
                with self.assertRaises(error):
                    self.issue([{"operation_id": self.request.operationId},
                                {"role": "owner"}, {"version": 2}, row])
                self.assertFalse(any("SET token_hash" in call.args[0]
                                     for call in self.connection.execute.call_args_list))
