"""The mediator's request, never the human exchange, is delivered to a worker."""
import unittest
from contextlib import nullcontext
from unittest.mock import Mock, patch
from uuid import uuid4

from mediator.db import room
from mediator.schemas.room import RoomMessageRequest


class RoomRelayTests(unittest.TestCase):
    def _post(self, target_available=True, mentioned=False, target_agent_id='agent-1', multiple_active=False, broadcast=False):
        project_id, user_id, task_id, exchange_id = (uuid4() for _ in range(4))
        human_text = ('Ask @My Codex for an update. My private note is SECRET.' if mentioned else
                      'Ask My Codex for an update. My private note is SECRET.')
        if broadcast:
            human_text = '@everyone please report status. My private note is SECRET.'
        row = {'id': exchange_id, 'body': human_text, 'state': 'pending'}
        target = {'agent_id': target_agent_id, 'agent_name': 'My Codex', 'status': 'in_progress'}
        tasks = [{'id': str(task_id), 'title': 'Current task', 'agent_id': 'agent-1',
                  'agent_name': 'My Codex', 'status': 'in_progress'}]
        if multiple_active:
            tasks.append({'id': str(uuid4()), 'title': 'Another task', 'agent_id': 'agent-1',
                          'agent_name': 'My Codex', 'status': 'claimed'})
        conn = Mock()
        saved = {}

        def execute(sql, params=None):
            cursor = Mock()
            if 'SELECT *, lease_until' in sql or 'AND state=\'pending\' AND lease_until' in sql:
                cursor.fetchone.return_value = None
            elif 'INSERT INTO public.agent_room_exchanges' in sql:
                cursor.fetchone.return_value = row
            elif 'SELECT t.claimed_by_agent_id::text AS agent_id' in sql:
                cursor.fetchone.return_value = target if target_available else None
            elif 'SET response=%s,state=\'complete\'' in sql:
                saved.update(params[0].obj)
                cursor.fetchone.return_value = {**row, 'response': saved, 'state': 'complete'}
            return cursor

        conn.execute.side_effect = execute
        model_reply = {'reply': 'I am asking My Codex for an update.', 'proposal': None,
                       'relayTaskId': str(task_id), 'relayMessage': 'What is your progress on this task?',
                       'requestPresence': False, 'cancelTaskIds': []}
        with patch.object(room, '_transaction', return_value=nullcontext(conn)), \
             patch.object(room, '_authorize', return_value=({'name': 'Project'}, 'owner', 'Human')), \
             patch.object(room, '_context', return_value={'tasks': tasks, 'agents': [
                 {'id': 'agent-1', 'name': 'My Codex'}, {'id': 'agent-2', 'name': 'Idle Claude'}]}), \
             patch.object(room, '_history', return_value=[row]), \
             patch.object(room, '_public', side_effect=lambda value: value), \
             patch.object(room, 'generate_plan', return_value=model_reply):
            result = room.post_message(project_id, RoomMessageRequest(operationId=uuid4(), body=human_text), user_id=user_id)
        return result, saved, human_text, str(task_id)

    def test_everyone_creates_separate_private_requests_for_active_and_idle_agents(self):
        _, saved, human_text, task_id = self._post(broadcast=True)
        requests = saved['workerRequests']
        self.assertEqual([item['agentId'] for item in requests], ['agent-1', 'agent-2'])
        self.assertEqual(requests[0]['taskId'], task_id)
        self.assertIsNone(requests[1]['taskId'])
        self.assertNotEqual(requests[0]['id'], requests[1]['id'])
        self.assertNotIn('SECRET', str(requests))
        self.assertNotIn(human_text, str(requests))

    def test_valid_target_receives_only_mediator_written_request(self):
        result, saved, human_text, task_id = self._post()
        self.assertEqual(result['body'], human_text)
        self.assertEqual(saved['workerRequest']['taskId'], task_id)
        self.assertEqual(saved['workerRequest']['agentId'], 'agent-1')
        self.assertEqual(saved['workerRequest']['message'], 'What is your progress on this task?')
        self.assertNotIn('SECRET', str(saved))

    def test_unavailable_target_is_not_claimed_as_queued(self):
        _, saved, _, _ = self._post(target_available=False)
        self.assertNotIn('workerRequest', saved)
        self.assertIn('could not relay', saved['reply'])

    def test_mention_cannot_be_rerouted_to_another_agent(self):
        _, saved, _, _ = self._post(mentioned=True, target_agent_id='agent-2')
        self.assertNotIn('workerRequest', saved)
        self.assertIn('could not relay', saved['reply'])

    def test_mention_with_multiple_tasks_requires_task_name(self):
        _, saved, _, _ = self._post(mentioned=True, multiple_active=True)
        self.assertNotIn('workerRequest', saved)
        self.assertIn('multiple active tasks', saved['reply'])

    def test_exact_mentions_support_spaces_and_reject_unknown_or_multiple_agents(self):
        tasks = [
            {'agent_id': 'agent-1', 'agent_name': 'My Codex', 'status': 'in_progress'},
            {'agent_id': 'agent-2', 'agent_name': 'Claude Laptop', 'status': 'claimed'},
        ]
        self.assertEqual(room._mentioned_agent('Ask @my codex for an update', tasks), ('agent-1', None))
        self.assertIsNotNone(room._mentioned_agent('Ask @Someone Else', tasks)[1])
        self.assertIsNotNone(room._mentioned_agent('Ask @My Codex and @Claude Laptop', tasks)[1])

    def test_worker_poll_returns_relay_text_without_private_human_body(self):
        project_id, task_id = uuid4(), uuid4()
        conn = Mock()
        conn.execute.return_value.fetchall.return_value = [{
            'body': 'Private human note: SECRET',
            'request': {'id': str(uuid4()), 'taskId': str(task_id),
                        'agentId': 'agent-1', 'message': 'What is your progress?'},
        }]
        with patch.object(room, '_transaction', return_value=nullcontext(conn)), \
             patch.object(room, '_authorize'):
            pending = room.pending_worker_requests(project_id, {'agentId': 'agent-1'}, task_id)
        self.assertEqual(pending['workerRequests'][0]['message'], 'What is your progress?')
        self.assertNotIn('SECRET', str(pending))
        self.assertEqual(conn.execute.call_args.args[1][2:4], (task_id, task_id))


if __name__ == '__main__':
    unittest.main()
