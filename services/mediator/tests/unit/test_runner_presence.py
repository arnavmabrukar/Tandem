"""Presence is acknowledged by the runner after receipt, never by authentication."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock, call

spec = importlib.util.spec_from_file_location(
    'tandem_runner', Path(__file__).resolve().parents[4] / 'agent-integrations/runner/tandem_runner.py')
runner_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner_module)


class RunnerPresenceTests(unittest.TestCase):
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
