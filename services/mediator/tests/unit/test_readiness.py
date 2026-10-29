"""Check failure behavior without requiring network access or credentials."""
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from psycopg import OperationalError
from pydantic import SecretStr

from mediator.main import app


class ReadinessTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def test_missing_database_is_not_ready_but_process_is_live(self):
        with patch("mediator.db.connection.settings.database_url", None):
            self.assertEqual(self.client.get("/ready").status_code, 503)
            self.assertEqual(self.client.get("/health").status_code, 200)

    def test_database_failure_does_not_leak_credentials(self):
        with patch("mediator.main.check_database", side_effect=OperationalError("secret-password")):
            response = self.client.get("/ready")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"detail": "Database unavailable"})

    def test_empty_url_cannot_fall_back_to_a_local_database(self):
        with patch("mediator.db.connection.settings.database_url", SecretStr("")):
            self.assertEqual(self.client.get("/ready").status_code, 503)

    def test_successful_database_check(self):
        with patch("mediator.main.check_database", return_value=True):
            self.assertEqual(self.client.get("/ready").json(), {"status": "ok", "database": "connected"})
