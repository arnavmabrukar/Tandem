"""Mediator delegation uses human permissions and normal assignment checks."""
from contextlib import nullcontext
from unittest import TestCase
from unittest.mock import Mock, patch
from uuid import uuid4

from mediator.db import room, assignments
from mediator.db.agent_tasks import AgentClaimBlocked
from mediator.schemas.room import RoomReply, RoomMessageRequest


class RoomAssignmentTests(TestCase):
    def setUp(self):
        self.project, self.user, self.task, self.agent, self.operation = [uuid4() for _ in range(5)]
        self.context = {
            'tasks': [{'id': str(self.task), 'title': 'Build UI', 'status': 'open', 'assigned_agent_id': None}],
            'agents': [{'id': str(self.agent), 'name': 'UI worker'}],
        }
        self.reply = RoomReply(reply='Queued', assignments=[{'taskId': self.task, 'agentId': self.agent}])
        self.conn = Mock()
        self.conn.transaction.side_effect = lambda: nullcontext()
        self.conn.execute.return_value.fetchone.return_value = {'version': 7}

    def apply(self):
        return room._assign_from_reply(self.conn, self.project, self.user, self.operation, self.reply, self.context)

    def test_assignments_share_transaction_and_stable_operation_ids(self):
        with patch.object(assignments, 'assign_task') as assign:
            self.assertEqual(self.apply(), 'Assigned Build UI to UI worker.')
            self.apply()
        first, second = assign.call_args_list
        self.assertEqual(first.args[3].operationId, second.args[3].operationId)
        self.assertEqual(first.args[:3], (self.user, self.project, self.task))
        self.assertEqual(first.args[3].agentId, str(self.agent))
        self.assertEqual(first.args[3].expectedVersion, 7)
        self.assertEqual(first.kwargs, {'connection': self.conn, 'require_unassigned': True})

    def test_duplicate_choices_assign_once(self):
        self.reply.assignments *= 2
        with patch.object(assignments, 'assign_task') as assign:
            self.apply()
        assign.assert_called_once()

    def test_unknown_agent_or_active_or_assigned_task_cannot_be_mutated(self):
        for change in ('unknown', 'active', 'assigned'):
            with self.subTest(change=change):
                self.setUp()
                if change == 'unknown':
                    self.context['agents'] = []
                elif change == 'active':
                    self.context['tasks'][0]['status'] = 'in_progress'
                else:
                    self.context['tasks'][0]['assigned_agent_id'] = str(uuid4())
                with patch.object(assignments, 'assign_task') as assign:
                    self.assertIn('Skipped', self.apply())
                assign.assert_not_called()

    def test_readiness_rejection_is_reported_instead_of_success(self):
        with patch.object(assignments, 'assign_task', side_effect=AgentClaimBlocked('Contract not approved')):
            outcome = self.apply()
        self.assertIn('Could not assign Build UI', outcome)
        self.assertIn('Contract not approved', outcome)

    def test_agent_authored_message_cannot_assign_and_human_receives_actual_outcome(self):
        for identity in (None, {'agentId': self.agent, 'projects': [{'projectId': str(self.project)}]}):
            with self.subTest(identity=identity):
                row = {'id': uuid4(), 'body': 'Distribute approved work', 'state': 'pending'}
                saved = {}
                def execute(sql, params=None):
                    cursor = Mock()
                    cursor.fetchone.return_value = None
                    if 'INSERT INTO public.agent_room_exchanges' in sql:
                        cursor.fetchone.return_value = row
                    if "SET response=%s,state='complete'" in sql:
                        saved.update(params[0].obj)
                        cursor.fetchone.return_value = {**row, 'response': saved}
                    return cursor
                self.conn.execute.side_effect = execute
                with patch.object(room, '_transaction', return_value=nullcontext(self.conn)), \
                        patch.object(room, '_authorize', return_value=({'name': 'Project'}, 'owner', 'Sender')), \
                        patch.object(room, '_context', return_value=self.context), \
                        patch.object(room, '_history', return_value=[row]), \
                        patch.object(room, '_public', side_effect=lambda value: value), \
                        patch.object(room, 'generate_plan', return_value=self.reply.model_dump()), \
                        patch.object(room, '_assign_from_reply', return_value='Assigned Build UI to UI worker.') as apply:
                    room.post_message(self.project, RoomMessageRequest(operationId=self.operation, body=row['body']),
                                      user_id=self.user if identity is None else None, identity=identity)
                if identity is None:
                    apply.assert_called_once()
                    self.assertEqual(saved['reply'], 'Assigned Build UI to UI worker.')
                else:
                    apply.assert_not_called()
                self.assertNotIn('assignments', saved)
