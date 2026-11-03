"""Presence is acknowledged by the runner after receipt, never by authentication."""
import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import Mock, call, patch

spec = importlib.util.spec_from_file_location(
    'tandem_runner', Path(__file__).resolve().parents[4] / 'agent-integrations/runner/tandem_runner.py')
runner_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner_module)


class RunnerPresenceTests(unittest.TestCase):
    def test_presence_only_never_constructs_a_repo_or_runs_tasks(self):
        with patch.dict(os.environ, {'TANDEM_AGENT_TOKEN': 'test-token'}), \
             patch.object(runner_module, 'Tandem') as tandem_class, \
             patch.object(runner_module, 'Repo') as repo, \
             patch.object(runner_module, 'Runner') as runner:
            tandem = tandem_class.return_value
            tandem.call.return_value = {'name': 'Agent', 'projects': [{'projectId': 'project'}]}
            tandem.project_call.side_effect = [{'presenceRequests': [{'id': 'check'}]}, {}]
            self.assertEqual(runner_module.main(['--presence-only', '--project', 'project', '--once']), 0)
            repo.assert_not_called()
            runner.assert_not_called()
            self.assertEqual(tandem.project_call.call_args_list, [
                call('tandem_get_presence_requests'), call('tandem_acknowledge_presence', checkId='check')])

    def test_expired_check_does_not_block_newer_checks(self):
        tandem = Mock()
        tandem.project_call.side_effect = [
            {'presenceRequests': [{'id': 'expired'}, {'id': 'recent'}]}, runner_module.ToolRefused(), {}]
        runner_module.acknowledge_presence(tandem)
        self.assertEqual(tandem.project_call.call_args_list[-1],
                         call('tandem_acknowledge_presence', checkId='recent'))

    def test_revocation_stops_presence_listener(self):
        tandem = Mock()
        tandem.project_call.side_effect = [
            {'presenceRequests': [{'id': 'check'}]}, runner_module.TokenRejected()]
        with self.assertRaises(runner_module.TokenRejected):
            runner_module.acknowledge_presence(tandem)

    def test_idle_poll_acknowledges_received_challenges_before_fetching_work(self):
        tandem = Mock()
        tandem.project_call.side_effect = [
            {'presenceRequests': [{'id': 'check-1'}, {'id': 'check-2'}]}, {}, {}, {'tasks': []}]
        runner = runner_module.Runner(tandem, Mock(), [], 60)
        self.assertIsNone(runner.next_task())
        self.assertEqual(tandem.project_call.call_args_list, [
            call('tandem_get_presence_requests'),
            call('tandem_acknowledge_presence', checkId='check-1'),
            call('tandem_acknowledge_presence', checkId='check-2'),
            call('tandem_get_assignments')])

    def test_no_pending_challenge_produces_no_acknowledgement(self):
        tandem = Mock()
        tandem.project_call.return_value = {'presenceRequests': []}
        runner_module.Runner(tandem, Mock(), [], 60).acknowledge_presence()
        tandem.project_call.assert_called_once_with('tandem_get_presence_requests')
