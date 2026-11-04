"""Humans can only submit room messages through the mediator endpoint."""
import unittest
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient

from mediator.main import app, get_current_user


class MediatorRoomApiTests(unittest.TestCase):
    def test_human_uses_mediator_route_and_cannot_directly_address_worker(self):
        project_id, user_id, operation_id = (uuid4() for _ in range(3))
        payload = {'operationId': str(operation_id), 'body': 'Ask My Codex for an update'}
        # Avoid restarting the shared MCP app lifespan after another route test.
        client = TestClient(app)
        with patch.dict(app.dependency_overrides, {get_current_user: lambda: {'id': str(user_id)}}), \
             patch('mediator.db.room.post_message', return_value={'queued': True}) as save:
            response = client.post(f'/api/projects/{project_id}/room', json=payload)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json(), {'queued': True})
            save.assert_called_once()
            self.assertEqual(save.call_args.args[0], project_id)
            self.assertEqual(save.call_args.args[1].operationId, operation_id)
            self.assertEqual(save.call_args.kwargs['user_id'], user_id)
            self.assertEqual(client.post(f'/api/projects/{project_id}/room/worker', json={**payload,
                'taskId': str(uuid4())}).status_code, 404)
            self.assertEqual(save.call_count, 1)


if __name__ == '__main__':
    unittest.main()
