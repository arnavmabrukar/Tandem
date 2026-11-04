"""Presence is acknowledged by the runner after receipt, never by authentication."""
import importlib.util
import os
import tempfile
from pathlib import Path
import unittest
from unittest.mock import Mock, call, patch

spec = importlib.util.spec_from_file_location(
    'tandem_runner', Path(__file__).resolve().parents[4] / 'agent-integrations/runner/tandem_runner.py')
runner_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner_module)


class RunnerPresenceTests(unittest.TestCase):
    def test_failed_clone_leaves_no_partial_workspace(self):
        with tempfile.TemporaryDirectory() as home, \
             patch.object(runner_module.Path, 'home', return_value=Path(home)), \
             patch.object(runner_module.shutil, 'which', return_value='/bin/tool'), \
             patch.object(runner_module.subprocess, 'run', return_value=Mock(returncode=1)):
            with self.assertRaisesRegex(runner_module.WorkBlocked, 'account with access'):
                runner_module.managed_clone('team/private', 'project', 'agent')
            self.assertEqual(list((Path(home) / '.local/share/tandem/workspaces').iterdir()), [])
            self.assertEqual(list((Path(home) / '.local/share/tandem/repositories').iterdir()), [])

    def test_managed_clone_rejects_non_repository_inputs(self):
        for repository in ('../repo', 'team/..', '--config=x', 'https://untrusted/repo', 'team/repo;command'):
            with self.assertRaises(runner_module.WorkBlocked):
                runner_module.managed_clone(repository, 'project', 'agent')

    def test_automatic_clone_requires_authenticated_project_access(self):
        with patch.dict(os.environ, {'TANDEM_AGENT_TOKEN': 'test-token'}), \
             patch.object(runner_module, 'Tandem') as tandem_class, \
             patch.object(runner_module, 'managed_clone') as clone:
            tandem_class.return_value.call.return_value = {'agentId': 'agent', 'name': 'Agent', 'projects': []}
            with self.assertRaisesRegex(SystemExit, 'no access'):
                runner_module.main(['--project', 'project', '--repository', 'team/private', '--check'])
            clone.assert_not_called()

    def test_worker_continues_between_ready_tasks_and_waits_when_empty(self):
        with patch.dict(os.environ, {'TANDEM_AGENT_TOKEN': 'test-token'}), \
             patch.object(runner_module.Path, 'exists', return_value=True), \
             patch.object(runner_module, 'Tandem') as tandem_class, \
             patch.object(runner_module, 'check_worker'), \
             patch.object(runner_module.Runner, 'run_once', side_effect=[True, True, False]) as work, \
             patch.object(runner_module.time, 'sleep', side_effect=KeyboardInterrupt) as sleep:
            tandem_class.return_value.call.return_value = {'name': 'Agent', 'projects': [{'projectId': 'project'}]}
            self.assertEqual(runner_module.main(['--project', 'project', '--repo', '/tmp/worker']), 0)
            self.assertEqual(work.call_count, 3)
            sleep.assert_called_once_with(20)

    def test_check_validates_worker_without_claiming_work(self):
        with patch.dict(os.environ, {'TANDEM_AGENT_TOKEN': 'test-token'}), \
             patch.object(runner_module.Path, 'exists', return_value=True), \
             patch.object(runner_module, 'Tandem') as tandem_class, \
             patch.object(runner_module, 'check_worker') as check, \
             patch.object(runner_module.Runner, 'run_once') as work:
            tandem_class.return_value.call.return_value = {'agentId': 'agent', 'name': 'Agent', 'projects': [{'projectId': 'project'}]}
            tandem_class.return_value.project_call.return_value = {'tasks': [], 'pushBranch': 'main'}
            self.assertEqual(runner_module.main(['--project', 'project', '--repo', '/tmp/worker', '--agent-id', 'agent', '--check']), 0)
            check.assert_called_once()
            work.assert_not_called()
            tandem_class.return_value.project_call.assert_called_once_with('tandem_get_assignments')

    def test_wrong_agent_token_cannot_start_worker(self):
        with patch.dict(os.environ, {'TANDEM_AGENT_TOKEN': 'test-token'}), \
             patch.object(runner_module, 'Tandem') as tandem_class:
            tandem_class.return_value.call.return_value = {'agentId': 'other', 'name': 'Other', 'projects': [{'projectId': 'project'}]}
            with self.assertRaisesRegex(SystemExit, 'different agent'):
                runner_module.main(['--presence-only', '--project', 'project', '--agent-id', 'agent', '--check'])
            tandem_class.return_value.project_call.assert_not_called()

    def test_hidden_token_prompt_overrides_environment_without_saving(self):
        with patch.dict(os.environ, {'TANDEM_AGENT_TOKEN': 'old-token'}), \
             patch.object(runner_module.sys.stdin, 'isatty', return_value=True), \
             patch.object(runner_module.getpass, 'getpass', return_value='new-token'), \
             patch.object(runner_module, 'Tandem') as tandem_class:
            tandem_class.return_value.call.return_value = {'name': 'Agent', 'projects': [{'projectId': 'project'}]}
            self.assertEqual(runner_module.main(['--presence-only', '--project', 'project', '--prompt-token', '--check']), 0)
            self.assertEqual(tandem_class.call_args.args[1], 'new-token')
            self.assertEqual(os.environ['TANDEM_AGENT_TOKEN'], 'old-token')

    def test_preflight_fails_before_work_when_cli_missing_or_clone_dirty(self):
        repo = Mock()
        with patch.object(runner_module.shutil, 'which', return_value=None):
            with self.assertRaisesRegex(runner_module.WorkBlocked, 'Install'):
                runner_module.check_worker(repo, ['codex'])
        with patch.object(runner_module.shutil, 'which', return_value='/bin/tool'):
            repo.dirty.return_value = True
            with self.assertRaisesRegex(runner_module.WorkBlocked, 'dedicated clone'):
                runner_module.check_worker(repo, ['codex'])

    def test_preflight_checks_logins_without_exposing_token_to_process(self):
        repo = Mock()
        repo.dirty.return_value = False
        with patch.dict(os.environ, {'TANDEM_AGENT_TOKEN': 'secret'}), \
             patch.object(runner_module.shutil, 'which', return_value='/bin/tool'), \
             patch.object(runner_module.subprocess, 'run', return_value=Mock(returncode=0)) as run:
            runner_module.check_worker(repo, ['codex'])
            self.assertEqual([c.args[0] for c in run.call_args_list], [['/bin/tool', 'login', 'status']])
            for invocation in run.call_args_list:
                self.assertNotIn('TANDEM_AGENT_TOKEN', invocation.kwargs['env'])

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

    def test_worker_room_poll_only_delivers_requests_for_current_task(self):
        tandem = Mock()
        tandem.project_call.return_value = {'workerRequests': [
            {'id': 'one', 'taskId': 'task-1', 'message': 'How is it going?'},
            {'id': 'two', 'taskId': 'task-2', 'message': 'Different task'},
        ]}
        self.assertEqual(runner_module.worker_room_requests(tandem, 'task-1'), [
            {'id': 'one', 'taskId': 'task-1', 'message': 'How is it going?'}])
        tandem.project_call.assert_called_once_with('tandem_get_worker_room_requests', taskId='task-1')
