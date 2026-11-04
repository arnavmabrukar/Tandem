"""The worker-message route requires a signed-in human and explicit task target."""
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

from fastapi.testclient import TestClient

from mediator.main import app, get_current_user


class WorkerRoomApiTests(unittest.TestCase):
    def test_explicit_human_request_is_validated_and_passes_authenticated_identity(self):
        project_id, user_id, task_id, operation_id = (uuid4() for _ in range(4))
        payload = {'operationId': str(operation_id), 'taskId': str(task_id), 'body': 'How is it going?'}
        # Avoid restarting the shared MCP app lifespan after another route test.
        client = TestClient(app)
        with patch.dict(app.dependency_overrides, {get_current_user: lambda: {'id': str(user_id)}}), \
             patch('mediator.db.room.post_worker_request', return_value={'queued': True}) as save:
            response = client.post(f'/api/projects/{project_id}/room/worker', json=payload)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json(), {'queued': True})
            save.assert_called_once()
            self.assertEqual(save.call_args.args[0], project_id)
            self.assertEqual(save.call_args.args[1].taskId, task_id)
            self.assertEqual(save.call_args.args[1].operationId, operation_id)
            self.assertEqual(save.call_args.args[2], UUID(str(user_id)))
            self.assertEqual(client.post(f'/api/projects/{project_id}/room/worker', json={
                'operationId': str(uuid4()), 'body': 'Missing task'}).status_code, 422)
            self.assertEqual(save.call_count, 1)


if __name__ == '__main__':
    unittest.main()
