"""Exercise authenticated MCP calls without using real credentials or Neon."""
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from psycopg import OperationalError

from mediator.main import app
from mediator.mcp.auth import verify_agent_token
from mediator.mcp.server import mcp


class MCPAuthTests(unittest.TestCase):
    def test_malformed_credentials_do_not_query_database(self):
        with patch("mediator.mcp.auth.psycopg.connect") as connect:
            for token in ("", "unissued:abc", "human-jwt", "tdm_short"):
                self.assertIsNone(verify_agent_token(token))
            connect.assert_not_called()

    def test_missing_invalid_and_unavailable(self):
        client = TestClient(app)
        self.addCleanup(client.close)
        with patch("mediator.mcp.auth.verify_agent_token", return_value=None):
            self.assertEqual(client.post("/mcp/").status_code, 401)
            with patch("mediator.mcp.auth.verify_agent_token", return_value=None):
                self.assertEqual(client.post("/mcp/", headers={"Authorization": "Bearer invalid"}).status_code, 401)
            with patch("mediator.mcp.auth.verify_agent_token", side_effect=OperationalError("secret")):
                response = client.post("/mcp/", headers={"Authorization": "Bearer invalid"})
                self.assertEqual(response.status_code, 503)
                self.assertNotIn("secret", response.text)

    def test_whoami_over_real_mcp_transport(self):
        identity = {"agentId": "agent-test", "ownerId": "owner-test", "name": "Test",
                    "client": "Codex", "projects": []}
        # The SDK's session manager normally starts once per process.
        mcp.session_manager._has_started = False
        # A fake verifier isolates the protocol test from database behavior.
        with patch("mediator.mcp.auth.verify_agent_token", return_value=identity), \
             patch("mediator.mcp.auth.record_agent_seen"), \
             TestClient(app, base_url="http://127.0.0.1:8000") as client:
            response = client.post("/mcp/", headers={
                "Authorization": "Bearer test-secret", "Accept": "application/json, text/event-stream",
                "MCP-Protocol-Version": "2025-03-26",
            }, json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                     "params": {"name": "tandem_whoami", "arguments": {}}})
            self.assertEqual(response.status_code, 200, response.text)
            result = response.json()["result"]
            self.assertFalse(result.get("isError", False), result)
            self.assertEqual(result["structuredContent"], identity)
            self.assertNotIn("test-secret", response.text)
