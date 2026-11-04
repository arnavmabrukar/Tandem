"""Browser preflights must allow room deletion without widening origin access."""
import unittest

from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

from mediator.main import app


class CORSTests(unittest.TestCase):
    def setUp(self):
        # CORS preflights do not need the MCP server's one-shot lifespan.
        self.client = TestClient(app, follow_redirects=False)
        self.addCleanup(self.client.close)

    def test_room_delete_preflight(self):
        cors = next(m for m in app.user_middleware if m.cls is CORSMiddleware)
        origin = cors.kwargs['allow_origins'][0]
        response = self.client.options('/api/projects/project-1/room', headers={
                'Origin': origin,
                'Access-Control-Request-Method': 'DELETE',
                'Access-Control-Request-Headers': 'authorization,content-type,idempotency-key',
            })
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers['access-control-allow-origin'], origin)
        self.assertIn('DELETE', response.headers['access-control-allow-methods'])

    def test_room_delete_rejects_unapproved_origin(self):
        response = self.client.options('/api/projects/project-1/room', headers={
                'Origin': 'https://unapproved.example',
                'Access-Control-Request-Method': 'DELETE',
                'Access-Control-Request-Headers': 'authorization,content-type',
            })
        self.assertEqual(response.status_code, 400)
        self.assertNotIn('access-control-allow-origin', response.headers)
