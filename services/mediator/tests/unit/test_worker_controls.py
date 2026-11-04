"""Controls target exact project agents and only authenticated workers report idle."""
from contextlib import nullcontext
from unittest import TestCase
from unittest.mock import Mock, patch
from uuid import uuid4

from mediator.db import room, agent_tasks, worker_controls
from mediator.schemas.room import RoomMessageRequest


class WorkerControlTests(TestCase):
    def setUp(self):
        self.project, self.actor, self.agent, self.operation = [uuid4() for _ in range(4)]
        self.agents = [{'id': str(self.agent), 'name': 'My Codex'}, {'id': str(uuid4()), 'name': 'Claude Laptop'}]
        self.identity = {'agentId': str(self.agent), 'ownerId': self.actor, 'name': 'My Codex'}

    def test_commands_require_exact_recipient_or_everyone(self):
        for text in ('/stop', '/start', '/stop My Codex', '/stop @Unknown', '/stop @My Codex extra', '/pause @everyone'):
            self.assertIn('error', room._control_command(text, self.agents))
        self.assertEqual(room._control_command('/STOP @my codex', self.agents), {'action': 'stop', 'agents': self.agents[:1]})
        self.assertEqual(room._control_command('/start @everyone', self.agents)['agents'], self.agents)
        self.assertIsNone(room._control_command('Please ask a question', self.agents))

    def test_claim_is_rejected_server_side_while_stopped(self):
        conn = Mock()
        with patch.object(agent_tasks, '_run_operation', side_effect=lambda *args: args[-1](conn, 1)), \
                patch.object(worker_controls, 'latest_control', return_value={'id': 'control', 'action': 'stop'}), \
                patch.object(agent_tasks, '_lock_task') as lock:
            with self.assertRaisesRegex(agent_tasks.AgentClaimBlocked, '/start'):
                agent_tasks.claim_task(self.identity, self.project, uuid4(), 1, self.operation)
        lock.assert_not_called()

    def test_stop_does_not_post_idle_while_task_is_active(self):
        conn = Mock()
        conn.execute.return_value.fetchone.return_value = {'active': True}
        with patch.object(worker_controls, '_transaction', return_value=nullcontext(conn)), \
                patch.object(room, '_authorize', return_value=({}, 'owner', 'My Codex')), \
                patch.object(worker_controls, 'latest_control', return_value={'id': str(self.operation), 'action': 'stop'}):
            result = worker_controls.acknowledge_control(self.project, self.operation, self.identity)
        self.assertFalse(result['acknowledged'])
        self.assertFalse(any('INSERT' in entry.args[0] for entry in conn.execute.call_args_list))

    def test_idle_ack_is_standalone_authenticated_and_idempotent(self):
        conn = Mock()
        row = {'id': uuid4(), 'body': "I'm idle. I won't claim new tasks until /start.", 'state': 'complete', 'response': None}
        def execute(sql, params=None):
            cursor = Mock()
            cursor.fetchone.return_value = row if 'INSERT INTO public.agent_room_exchanges' in sql else None
            return cursor
        conn.execute.side_effect = execute
        with patch.object(worker_controls, '_transaction', return_value=nullcontext(conn)), \
                patch.object(room, '_authorize', return_value=({}, 'owner', 'My Codex')), \
                patch.object(room, '_public', side_effect=lambda item: item), \
                patch.object(worker_controls, 'latest_control', return_value={'id': str(self.operation), 'action': 'stop'}):
            self.assertTrue(worker_controls.acknowledge_control(self.project, self.operation, self.identity)['acknowledged'])
            insertion = next(entry for entry in conn.execute.call_args_list if 'INSERT' in entry.args[0])
            self.assertEqual(insertion.args[1][1], self.identity['agentId'])
            self.assertIn("I'm idle", insertion.args[1][4])
            conn.execute.side_effect = None
            conn.execute.return_value.fetchone.side_effect = [None, row]
            conn.execute.reset_mock()
            self.assertTrue(worker_controls.acknowledge_control(self.project, self.operation, self.identity)['acknowledged'])
            self.assertFalse(any('INSERT' in entry.args[0] for entry in conn.execute.call_args_list))

    def test_another_agents_control_cannot_be_acknowledged(self):
        with patch.object(worker_controls, '_transaction', return_value=nullcontext(Mock())), \
                patch.object(room, '_authorize', return_value=({}, 'owner', 'My Codex')), \
                patch.object(worker_controls, 'latest_control', return_value=None):
            with self.assertRaises(agent_tasks.AgentOperationConflict):
                worker_controls.acknowledge_control(self.project, self.operation, self.identity)

    def test_controls_persist_outside_deletable_chat_and_use_stable_ids(self):
        conn = Mock()
        conn.execute.return_value.fetchall.return_value = [{'id': agent['id']} for agent in self.agents]
        worker_controls.save_controls(conn, self.project, self.actor, self.operation, 'stop', self.agents)
        inserts = [c for c in conn.execute.call_args_list if 'INSERT' in c.args[0]]
        self.assertEqual(len(inserts), 2)
        self.assertTrue(all('public.operations' in c.args[0] for c in inserts))
        self.assertNotEqual(inserts[0].args[1][1], inserts[1].args[1][1])
        self.assertEqual(inserts[0].args[1][2].obj['action'], 'stop')

    def test_invalid_slash_command_does_not_invoke_model_or_save_control(self):
        conn = Mock()
        row = {'id': uuid4(), 'state': 'pending', 'body': '/stop'}
        def execute(sql, params=None):
            cursor = Mock()
            cursor.fetchone.return_value = None
            if 'INSERT INTO public.agent_room_exchanges' in sql: cursor.fetchone.return_value = row
            if "SET response=%s,state='complete'" in sql: cursor.fetchone.return_value = {**row, 'response': params[0].obj}
            return cursor
        conn.execute.side_effect = execute
        with patch.object(room, '_transaction', return_value=nullcontext(conn)), \
                patch.object(room, '_authorize', return_value=({}, 'owner', 'Human')), \
                patch.object(room, '_context', return_value={'tasks': [], 'agents': self.agents}), \
                patch.object(room, '_history', return_value=[row]), patch.object(room, '_public', side_effect=lambda r: r), \
                patch.object(room, 'generate_plan') as model, patch.object(worker_controls, 'save_controls') as save:
            result = room.post_message(self.project, RoomMessageRequest(operationId=self.operation, body='/stop'), user_id=self.actor)
        self.assertIn('Use /start @Agent Name', result['response']['reply'])
        model.assert_not_called()
        save.assert_not_called()

    def test_valid_everyone_command_saves_targets_without_model_inference(self):
        conn = Mock()
        row = {'id': uuid4(), 'state': 'pending', 'body': '/stop @everyone'}
        def execute(sql, params=None):
            cursor = Mock()
            cursor.fetchone.return_value = None
            if 'INSERT INTO public.agent_room_exchanges' in sql: cursor.fetchone.return_value = row
            if "SET response=%s,state='complete'" in sql: cursor.fetchone.return_value = {**row, 'response': params[0].obj}
            return cursor
        conn.execute.side_effect = execute
        with patch.object(room, '_transaction', return_value=nullcontext(conn)), \
                patch.object(room, '_authorize', return_value=({}, 'reviewer', 'Human')), \
                patch.object(room, '_context', return_value={'tasks': [], 'agents': self.agents}), \
                patch.object(room, '_history', return_value=[row]), patch.object(room, '_public', side_effect=lambda r: r), \
                patch.object(room, 'generate_plan') as model, patch.object(worker_controls, 'save_controls') as save:
            result = room.post_message(self.project, RoomMessageRequest(operationId=self.operation, body=row['body']), user_id=self.actor)
        save.assert_called_once_with(conn, self.project, self.actor, self.operation, 'stop', self.agents)
        self.assertIn('finish current work', result['response']['reply'])
        self.assertNotIn("I'm idle", result['response']['reply'])
        model.assert_not_called()

    def test_revoked_target_prevents_saving_command(self):
        conn = Mock()
        conn.execute.return_value.fetchall.return_value = []
        with self.assertRaises(agent_tasks.AgentOperationConflict):
            worker_controls.save_controls(conn, self.project, self.actor, self.operation, 'stop', self.agents)
        self.assertFalse(any('INSERT' in c.args[0] for c in conn.execute.call_args_list))
