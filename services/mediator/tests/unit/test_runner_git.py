"""Exercise branch isolation and agent conflict resolution using real local Git repositories."""
import importlib.util
import json
import os
import socket
import shlex
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location(
    'runner_git', Path(__file__).resolve().parents[4] / 'agent-integrations/runner/tandem_runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class RunnerGitTests(unittest.TestCase):
    def setUp(self):
        self.no_room_requests = patch.object(runner, 'worker_room_requests', return_value=[])
        self.no_room_requests.start()
        self.addCleanup(self.no_room_requests.stop)
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.env = {**os.environ, 'GIT_AUTHOR_NAME': 'Test', 'GIT_AUTHOR_EMAIL': 'test@example.test',
                    'GIT_COMMITTER_NAME': 'Test', 'GIT_COMMITTER_EMAIL': 'test@example.test',
                    'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull}
        self.environment = patch.dict(os.environ, self.env)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.remote = self.root / 'remote.git'
        self.git(self.root, 'init', '--bare', '--initial-branch=main', str(self.remote))
        self.source = self.root / 'source'
        self.git(self.root, 'clone', str(self.remote), str(self.source))
        (self.source / 'shared.txt').write_text('original\n')
        self.commit(self.source, 'Initial')
        self.git(self.source, 'push', 'origin', 'main')
        self.worker = self.root / 'worker'
        self.git(self.root, 'clone', str(self.remote), str(self.worker))
        self.repo = runner.Repo(self.worker)
        self.task = {'id': '12345678-task', 'title': 'Task', 'description': '', 'messages': [],
                     'contract': {'summary': 'Combine changes', 'paths': ['shared.txt'],
                                  'acceptanceCriteria': ['Preserve both changes']}}

    def git(self, cwd, *args):
        return subprocess.run(['git', *args], cwd=cwd, env=self.env, check=True,
                              capture_output=True, text=True).stdout.strip()

    def commit(self, path, message):
        self.git(path, 'add', '.')
        self.git(path, 'commit', '-m', message)

    def make_conflict(self):
        branch = runner.branch_name(self.task)
        self.repo.prepare(branch)
        (self.worker / 'shared.txt').write_text('agent change\n')
        self.commit(self.worker, 'Agent work')
        (self.source / 'shared.txt').write_text('teammate change\n')
        self.commit(self.source, 'Teammate work')
        self.git(self.source, 'push', 'origin', 'main')
        return branch

    def test_conflict_is_resolved_by_agent_and_both_histories_preserved(self):
        branch = self.make_conflict()
        worker = runner.Runner(Mock(), self.repo, ['fake-agent'], 60)

        def resolve(prompt):
            self.assertIn('Resolve the conflicted files', prompt)
            self.assertTrue(self.repo.exists('MERGE_HEAD'))
            (self.worker / 'shared.txt').write_text('agent change\nteammate change\n')
            return 0, 'Combined both changes and checked the result.'

        with patch.object(worker, '_run_agent_with_keepalive', side_effect=resolve) as agent:
            worker._integrate_base(self.task, branch, 'main')
            worker._integrate_base(self.task, branch, 'main')
        self.assertEqual(agent.call_count, 1)
        self.assertTrue(self.repo.contains('origin/main'))
        self.assertFalse(self.repo.dirty())
        self.assertFalse(self.repo.exists('MERGE_HEAD'))
        self.assertEqual(len(self.repo.git('rev-list', '--parents', '-n', '1', 'HEAD').split()), 3)
        self.assertEqual(self.git(self.source, 'branch', '--show-current'), 'main')

    def test_unresolved_conflict_preserves_files_and_never_pushes(self):
        branch = self.make_conflict()
        worker = runner.Runner(Mock(), self.repo, ['fake-agent'], 60)
        with patch.object(worker, '_run_agent_with_keepalive', return_value=(0, 'Unresolved')):
            with self.assertRaisesRegex(runner.WorkBlocked, 'preserved for inspection'):
                worker._integrate_base(self.task, branch, 'main')
        self.assertTrue(self.repo.exists('MERGE_HEAD'))
        self.assertIn('<<<<<<<', (self.worker / 'shared.txt').read_text())
        self.assertFalse(self.repo.exists(f'origin/{branch}'))

    def test_new_teammate_changes_are_integrated_before_task_push(self):
        worker = runner.Runner(Mock(), self.repo, ['fake-agent'], 60)

        def agent(prompt):
            if 'Integration step:' in prompt:
                (self.worker / 'shared.txt').write_text('agent change\nteammate change\n')
            else:
                (self.worker / 'shared.txt').write_text('agent change\n')
                self.commit(self.worker, 'Task implementation')
                (self.source / 'shared.txt').write_text('teammate change\n')
                self.commit(self.source, 'Concurrent teammate change')
                self.git(self.source, 'push', 'origin', 'main')
            return 0, 'Tests passed.'

        with patch.object(worker, '_run_agent_with_keepalive', side_effect=agent) as execute:
            result = worker._execute(self.task)
        self.assertEqual(execute.call_count, 2)
        self.assertIn('main', result['progress'])
        self.assertTrue(self.repo.contains('origin/main'))
        self.assertEqual(self.repo.git('rev-parse', 'origin/main'), self.repo.git('rev-parse', 'HEAD'))
        self.git(self.source, 'fetch', 'origin')
        self.assertEqual(self.git(self.source, 'show', 'origin/main:shared.txt'), 'agent change\nteammate change')

    def test_review_refresh_resolves_conflict_without_redoing_the_task(self):
        branch = self.make_conflict()
        self.repo.git('push', '-u', 'origin', branch)
        worker = runner.Runner(Mock(), self.repo, ['fake-agent'], 60)

        def agent(prompt):
            if 'Integration step:' in prompt:
                (self.worker / 'shared.txt').write_text('agent change\nteammate change\n')
            else:
                self.assertIn('Review update:', prompt)
            return 0, 'Validated the combined result.'

        with patch.object(worker, '_run_agent_with_keepalive', side_effect=agent):
            worker._execute(self.task, review_refresh=True)
        self.assertTrue(self.repo.contains('origin/main'))
        self.assertFalse(self.repo.dirty())

    def test_automatic_download_shares_one_clone_between_agents(self):
        actual_run = subprocess.run
        actual_which = runner.shutil.which
        downloads = []

        def run(command, **kwargs):
            if command[:3] == ['gh', 'repo', 'clone']:
                self.assertNotIn('TANDEM_AGENT_TOKEN', kwargs['env'])
                downloads.append(command)
                result = actual_run(['git', 'clone', str(self.remote), command[-1]], **kwargs)
                self.git(Path(command[-1]), 'remote', 'set-url', 'origin', 'https://github.com/team/private.git')
                self.git(Path(command[-1]), 'config', f'url.{self.remote}.insteadOf', 'https://github.com/team/private.git')
                return result
            return actual_run(command, **kwargs)

        with patch.object(runner.Path, 'home', return_value=self.root / 'home'), \
             patch.object(runner.Path, 'cwd', return_value=self.root), \
             patch.object(runner.shutil, 'which', side_effect=lambda cmd, **kw: actual_which(cmd, **kw) if cmd == 'git' else '/bin/tool'), \
             patch.object(runner.subprocess, 'run', side_effect=run), \
             patch.dict(os.environ, {'TANDEM_AGENT_TOKEN': 'secret'}):
            first = runner.managed_clone('team/private', 'project', 'agent-one')
            second = runner.managed_clone('team/private', 'project', 'agent-two')
            self.assertEqual(len(downloads), 1)
            self.assertNotEqual(first, second)
            self.assertEqual(runner.Repo(first).git('rev-parse', '--git-common-dir'),
                             runner.Repo(second).git('rev-parse', '--git-common-dir'))

    def test_shared_worktrees_reuse_project_repository_without_changing_user_checkout(self):
        # Rewrite GitHub URLs only within this test so all fetches remain local.
        github = 'https://github.com/team/private.git'
        self.git(self.source, 'remote', 'set-url', 'origin', github)
        self.git(self.source, 'config', f'url.{self.remote}.insteadOf', github)
        (self.source / 'shared.txt').write_text('uncommitted human work\n')
        actual_which = runner.shutil.which
        with patch.object(runner.Path, 'home', return_value=self.root / 'home'), \
             patch.object(runner.Path, 'cwd', return_value=self.source), \
             patch.object(runner.shutil, 'which', side_effect=lambda cmd, **kw: actual_which(cmd, **kw) if cmd == 'git' else '/bin/tool'), \
             patch.dict(os.environ, {'TANDEM_AGENT_TOKEN': 'secret'}):
            first = runner.managed_clone('team/private', 'project', 'agent-one')
            second = runner.managed_clone('team/private', 'project', 'agent-two')
            self.assertEqual(runner.managed_clone('team/private', 'project', 'agent-one'), first)
            one, two = runner.Repo(first), runner.Repo(second)
            self.assertEqual(one.git('rev-parse', '--git-common-dir'), two.git('rev-parse', '--git-common-dir'))
            one.prepare('tandem/first')
            two.prepare('tandem/second')
            (first / 'shared.txt').write_text('first agent\n')
            self.assertEqual((second / 'shared.txt').read_text(), 'original\n')
            self.assertEqual((self.source / 'shared.txt').read_text(), 'uncommitted human work\n')
            self.assertEqual(self.git(self.source, 'branch', '--show-current'), 'main')
            marker = Path(one.git('rev-parse', '--absolute-git-dir')) / 'tandem-worker.json'
            marker.unlink()
            with self.assertRaisesRegex(runner.WorkBlocked, 'does not belong'):
                runner.managed_clone('team/private', 'project', 'agent-one')

    def test_server_setting_controls_push_branch_and_blank_defaults_to_main(self):
        task = {**self.task, 'status': 'open', 'claimable': True}
        tandem = Mock()
        tandem.project_call.side_effect = lambda tool, **kw: (
            {'presenceRequests': []}
            if tool == 'tandem_get_presence_requests'
            else {'tasks': [task], 'pushBranch': 'agents/integration'}
        )
        worker = runner.Runner(tandem, self.repo, [], 60)
        self.assertEqual(worker.next_task(), task)
        self.assertEqual(worker.push_branch, 'agents/integration')
        self.assertEqual(self.repo.base, 'agents/integration')
        self.assertEqual(runner.push_branch(''), 'main')
        for invalid in ('HEAD', 'refs/heads/main', '../main', 'bad branch', 'x.lock'):
            with self.subTest(invalid=invalid), self.assertRaises(runner.WorkBlocked):
                runner.push_branch(invalid)

    def test_runner_verifies_commits_and_pushes_uncommitted_agent_edits(self):
        command = [sys.executable, '-c', "from pathlib import Path; assert Path('shared.txt').read_text() == 'finished\\n'"]
        worker = runner.Runner(Mock(), self.repo, [], 60, verify_commands=[command])
        def edit(prompt):
            self.assertIn('Do not commit, push', prompt)
            (self.worker / 'shared.txt').write_text('finished\n')
            return 0, 'Implementation ready for runner verification.'
        with patch.object(worker, '_run_agent_with_keepalive', side_effect=edit), \
             patch.object(worker, '_sandboxed_check', return_value=Mock(returncode=0)):
            result = worker._execute(self.task)
        self.assertIn('Passed in OS sandbox:', result['message'])
        self.assertIn('Commit:', result['message'])
        self.assertFalse(self.repo.dirty())
        self.assertEqual(self.repo.git('rev-parse', 'HEAD'), self.repo.git('rev-parse', 'origin/main'))

    def test_queued_room_message_gets_a_real_agent_turn_before_publication(self):
        self.no_room_requests.stop()
        tandem = Mock()
        tandem.project_call.side_effect = lambda tool, **kwargs: self.task if tool == 'tandem_get_task' else {}
        worker = runner.Runner(tandem, self.repo, [], 60, verify_commands=[[sys.executable, '-c', 'pass']])
        prompts = []

        def agent(prompt):
            prompts.append(prompt)
            if len(prompts) == 1:
                (self.worker / 'shared.txt').write_text('finished\n')
                return 0, 'Implementation ready.'
            self.assertIn('Can you explain the progress?', prompt)
            return 0, 'I finished the implementation and am verifying it now.'

        with patch.object(runner, 'worker_room_requests', side_effect=[[
                {'id': 'request-1', 'taskId': self.task['id'], 'message': 'Can you explain the progress?'}], []]), \
             patch.object(worker, '_run_agent_with_keepalive', side_effect=agent), \
             patch.object(worker, '_sandboxed_check', return_value=Mock(returncode=0)):
            worker._execute(self.task)
        self.assertEqual(len(prompts), 2)
        tandem.project_call.assert_any_call('tandem_reply_worker_room_request', requestId='request-1',
                                            body='I finished the implementation and am verifying it now.')
        self.assertEqual(self.repo.git('rev-parse', 'HEAD'), self.repo.git('rev-parse', 'origin/main'))

    def test_runner_pushes_only_to_server_configured_branch(self):
        self.git(self.source, 'checkout', '-b', 'agents/integration')
        self.git(self.source, 'push', 'origin', 'agents/integration')
        self.git(self.source, 'checkout', 'main')
        main_before = self.repo.git('rev-parse', 'origin/main')
        worker = runner.Runner(Mock(), self.repo, [], 60)
        worker._apply_project_settings({'pushBranch': 'agents/integration', 'tasks': []})

        def edit(prompt):
            self.assertIn('branch tandem/', prompt)
            (self.worker / 'shared.txt').write_text('configured branch only\n')
            return 0, 'Ready.'

        with patch.object(worker, '_run_agent_with_keepalive', side_effect=edit):
            result = worker._execute(self.task)
        self.assertIn('agents/integration', result['progress'])
        self.assertEqual(self.repo.git('rev-parse', 'HEAD'),
                         self.repo.git('rev-parse', 'origin/agents/integration'))
        self.assertEqual(self.repo.git('rev-parse', 'origin/main'), main_before)
        self.assertFalse(self.repo.exists(f'origin/{runner.branch_name(self.task)}'))

    def test_branch_setting_change_during_task_blocks_publication(self):
        tandem = Mock()
        tandem.project_call.return_value = {'tasks': [], 'pushBranch': 'agents/new-target'}
        main_before = self.repo.git('rev-parse', 'origin/main')
        worker = runner.Runner(tandem, self.repo, [], 60)
        worker._apply_project_settings({'tasks': [], 'pushBranch': 'main'})
        worker.active_task = self.task

        def edit(prompt):
            (self.worker / 'shared.txt').write_text('do not publish to the old target\n')
            return 0, 'Ready.'

        with patch.object(worker, '_run_agent_with_keepalive', side_effect=edit), \
             patch.object(worker, '_phase'):
            with self.assertRaisesRegex(runner.WorkBlocked, 'changed from main to agents/new-target'):
                worker._execute(self.task)
        self.assertEqual(self.repo.git('rev-parse', 'origin/main'), main_before)
        self.assertFalse(self.repo.exists(f'origin/{runner.branch_name(self.task)}'))

    def test_failed_verification_never_commits_or_pushes_and_preserves_edits(self):
        before = self.repo.git('rev-parse', 'HEAD')
        worker = runner.Runner(Mock(), self.repo, [], 60,
                               verify_commands=[[sys.executable, '-c', 'raise SystemExit(1)']])
        def edit(prompt):
            (self.worker / 'shared.txt').write_text('unfinished\n')
            return 0, 'Tests passed.'  # The runner must verify this claim itself.
        with patch.object(worker, '_run_agent_with_keepalive', side_effect=edit), \
             patch.object(worker, '_sandboxed_check', return_value=Mock(returncode=1, stdout='', stderr='failed')):
            with self.assertRaisesRegex(runner.WorkBlocked, 'Verification failed'):
                worker._execute(self.task)
        self.assertEqual(self.repo.git('rev-parse', 'HEAD'), before)
        self.assertTrue(self.repo.dirty())
        self.assertFalse(self.repo.exists(f'origin/{runner.branch_name(self.task)}'))

    def test_resume_uses_saved_changes_only_on_the_matching_task_branch(self):
        branch = runner.branch_name(self.task)
        self.repo.prepare(branch)
        (self.worker / 'shared.txt').write_text('saved work\n')
        worker = runner.Runner(Mock(), self.repo, [], 60, resume_task=self.task['id'])
        def resume(prompt):
            self.assertIn('Resume the saved changes', prompt)
            self.assertEqual((self.worker / 'shared.txt').read_text(), 'saved work\n')
            return 0, 'Saved implementation checked.'
        with patch.object(worker, '_run_agent_with_keepalive', side_effect=resume):
            worker._execute(self.task)
        self.assertFalse(self.repo.dirty())
        other = {**self.task, 'id': 'different-task'}
        (self.worker / 'shared.txt').write_text('keep this\n')
        with self.assertRaisesRegex(runner.WorkBlocked, 'uncommitted changes'):
            self.repo.prepare(runner.branch_name(other), resume=True)
        self.assertEqual((self.worker / 'shared.txt').read_text(), 'keep this\n')

    def test_detected_npm_checks_run_with_ci_and_without_tandem_token(self):
        self.repo.prepare(runner.branch_name(self.task))
        (self.worker / 'package.json').write_text(json.dumps({'scripts': {'test': 'test-tool', 'build': 'build-tool'}}))
        worker = runner.Runner(Mock(), self.repo, [], 60)
        with patch.object(worker, '_sandboxed_check', return_value=Mock(returncode=0)) as sandbox:
            worker._finalize(self.task, runner.branch_name(self.task))
        self.assertEqual([c.args[0] for c in sandbox.call_args_list], [['npm', 'run', 'test'], ['npm', 'run', 'build']])

    def test_missing_sandbox_never_executes_project_command_or_pushes(self):
        self.repo.prepare(runner.branch_name(self.task))
        (self.worker / 'shared.txt').write_text('saved edits\n')
        worker = runner.Runner(Mock(), self.repo, [], 60, verify_commands=[['npm', 'test']])
        actual_which = runner.shutil.which
        with patch.object(runner.shutil, 'which', side_effect=lambda cmd, **kw: None if cmd == 'srt' else actual_which(cmd, **kw)), \
             patch.object(runner.subprocess, 'run') as process:
            with self.assertRaisesRegex(runner.WorkBlocked, 'Sandbox Runtime'):
                worker._sandboxed_check(['npm', 'test'])
            process.assert_not_called()
        self.assertTrue(self.repo.dirty())
        self.assertFalse(self.repo.exists(f'origin/{runner.branch_name(self.task)}'))

    def test_verifier_uses_fixed_policy_and_minimal_environment(self):
        worker = runner.Runner(Mock(), self.repo, [], 60)
        actual_run, actual_which = subprocess.run, runner.shutil.which
        def run(command, **kw):
            if Path(command[0]).name == 'trusted-srt':
                if command[1] == '--version':
                    return Mock(returncode=0, stdout='0.0.81')
                policy_path = Path(command[2])
                policy = json.loads(policy_path.read_text())
                self.assertFalse(policy_path.is_relative_to(self.worker))
                self.assertIn('/', policy['filesystem']['denyRead'])
                self.assertEqual(policy['network']['allowedDomains'], [])
                self.assertFalse(policy['network']['allowLocalBinding'])
                self.assertFalse(policy['enableWeakerNestedSandbox'])
                self.assertNotIn('TANDEM_AGENT_TOKEN', kw['env'])
                self.assertNotIn('OPENAI_API_KEY', kw['env'])
                self.assertNotIn('NPM_TOKEN', kw['env'])
                self.assertNotIn('NODE_OPTIONS', kw['env'])
                self.assertNotEqual(kw['env']['HOME'], str(Path.home()))
                return Mock(returncode=126, stdout='', stderr='sandbox denied')
            return actual_run(command, **kw)
        with patch.object(runner.shutil, 'which', side_effect=lambda cmd, **kw: '/tmp/trusted-srt' if cmd == 'srt' else actual_which(cmd, **kw)), \
             patch.object(runner.subprocess, 'run', side_effect=run), \
             patch.dict(os.environ, {'TANDEM_AGENT_TOKEN': 'secret', 'OPENAI_API_KEY': 'secret', 'NPM_TOKEN': 'secret', 'NODE_OPTIONS': '--require malicious'}):
            result = worker._sandboxed_check(['npm', 'test'])
        self.assertEqual(result.returncode, 126)  # No unsandboxed retry.

    def test_unsupported_runtime_version_never_starts_a_project_command(self):
        actual_which = runner.shutil.which
        for version in ('0.0.80', '0.0.82', 'unknown'):
            with self.subTest(version=version), \
                 patch.object(runner.shutil, 'which', side_effect=lambda cmd, **kw: '/tmp/trusted-srt' if cmd == 'srt' else actual_which(cmd, **kw)), \
                 patch.object(runner.subprocess, 'run', return_value=Mock(returncode=0, stdout=version)) as process:
                with self.assertRaisesRegex(runner.WorkBlocked, '0.0.81 is required'):
                    runner.Runner(Mock(), self.repo, [], 60)._sandboxed_check(['npm', 'test'])
                process.assert_called_once()
                self.assertEqual(process.call_args.args[0][1:], ['--version'])

    def test_runner_git_disables_project_hooks_and_filters(self):
        self.repo.prepare(runner.branch_name(self.task))
        marker = self.root / 'hook-or-filter-ran'
        hooks = self.worker / '.hooks'
        hooks.mkdir()
        hook = hooks / 'pre-commit'
        hook.write_text(f'#!/bin/sh\necho unsafe > "{marker}"\n')
        hook.chmod(0o755)
        self.git(self.worker, 'config', 'core.hooksPath', '.hooks')
        runner.Runner(Mock(), self.repo, [], 60)._finalize(self.task, runner.branch_name(self.task))
        self.assertFalse(marker.exists())
        self.git(self.worker, 'config', 'filter.untrusted.clean', f'echo unsafe > "{marker}"')
        self.git(self.worker, 'config', 'filter.untrusted.required', 'true')
        (self.worker / '.gitattributes').write_text('shared.txt filter=untrusted\n')
        (self.worker / 'shared.txt').write_text('safe contents\n')
        with self.assertRaisesRegex(runner.WorkBlocked, 'Git content filter'):
            runner.Runner(Mock(), self.repo, [], 60)._finalize(self.task, runner.branch_name(self.task))
        self.assertFalse(marker.exists())
        self.assertEqual((self.worker / 'shared.txt').read_text(), 'safe contents\n')

    @unittest.skipUnless(os.environ.get('TANDEM_TEST_SANDBOX_RUNTIME'), 'Requires an explicitly installed OS sandbox runtime')
    def test_os_sandbox_blocks_outside_reads_writes_network_and_environment(self):
        outside = self.root / 'outside-secret'
        outside.write_text('private sentinel')
        marker = self.root / 'outside-write'
        listener = socket.socket()
        listener.bind(('127.0.0.1', 0))
        listener.listen(1)
        self.addCleanup(listener.close)
        port = listener.getsockname()[1]
        source = """import os, socket
from pathlib import Path
assert 'TANDEM_AGENT_TOKEN' not in os.environ
assert 'OPENAI_API_KEY' not in os.environ
try:
    Path(%r).read_text()
except (PermissionError, FileNotFoundError): pass
else: raise AssertionError('outside read allowed')
try:
    Path(%r).write_text('unsafe')
except (PermissionError, FileNotFoundError): pass
else: raise AssertionError('outside write allowed')
try:
    socket.create_connection(('127.0.0.1', %d), timeout=1)
except OSError: pass
else: raise AssertionError('network allowed')
Path('sandbox-result').write_text('checks passed')
""" % (str(outside), str(marker), port)
        actual_which = runner.shutil.which
        with patch.object(runner.shutil, 'which', side_effect=lambda cmd, **kw: os.environ['TANDEM_TEST_SANDBOX_RUNTIME'] if cmd == 'srt' else actual_which(cmd, **kw)), \
             patch.dict(os.environ, {'TANDEM_AGENT_TOKEN': 'secret', 'OPENAI_API_KEY': 'secret'}):
            result = runner.Runner(Mock(), self.repo, [], 60)._sandboxed_check([sys.executable, '-c', source])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(marker.exists())
        self.assertEqual(outside.read_text(), 'private sentinel')
        self.assertEqual((self.worker / 'sandbox-result').read_text(), 'checks passed')

    @unittest.skipUnless(os.environ.get('TANDEM_TEST_SANDBOX_RUNTIME'), 'Requires an explicitly installed OS sandbox runtime')
    def test_edited_npm_script_cannot_run_with_host_access(self):
        self.repo.prepare(runner.branch_name(self.task))
        marker = self.root / 'escaped-from-npm'
        package = self.worker / 'package.json'
        actual_which = runner.shutil.which
        worker = runner.Runner(Mock(), self.repo, [], 60)
        def script(body):
            package.write_text(json.dumps({'scripts': {'test': f'node -e {shlex.quote(body)}'}}))
        with patch.object(runner.shutil, 'which', side_effect=lambda cmd, **kw: os.environ['TANDEM_TEST_SANDBOX_RUNTIME'] if cmd == 'srt' else actual_which(cmd, **kw)):
            script("require('fs').writeFileSync('allowed-build-output', 'ok')")
            control = worker._sandboxed_check(['npm', 'run', 'test'])
            self.assertEqual(control.returncode, 0, control.stderr)
            self.assertTrue((self.worker / 'allowed-build-output').exists())
            before = self.repo.git('rev-parse', 'HEAD')
            script(f"require('fs').writeFileSync({json.dumps(str(marker))}, 'unsafe')")
            with self.assertRaisesRegex(runner.WorkBlocked, 'Verification failed'):
                worker._finalize(self.task, runner.branch_name(self.task))
        self.assertFalse(marker.exists())
        self.assertEqual(self.repo.git('rev-parse', 'HEAD'), before)
        self.assertTrue(self.repo.dirty())
        self.assertFalse(self.repo.exists(f'origin/{runner.branch_name(self.task)}'))

    @unittest.skipUnless(os.environ.get('TANDEM_TEST_SANDBOX_RUNTIME'), 'Requires an explicitly installed OS sandbox runtime')
    def test_workspace_symlink_cannot_grant_access_to_an_outside_executable(self):
        private_tool = self.root / 'private-tool'
        private_tool.write_text('#!/bin/sh\necho leaked > leaked-from-tool\n')
        private_tool.chmod(0o755)
        link = self.worker / 'verify-script'
        link.symlink_to(private_tool)
        actual_which = runner.shutil.which
        with patch.object(runner.shutil, 'which', side_effect=lambda cmd, **kw: os.environ['TANDEM_TEST_SANDBOX_RUNTIME'] if cmd == 'srt' else actual_which(cmd, **kw)):
            result = runner.Runner(Mock(), self.repo, [], 60)._sandboxed_check([str(link)])
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.worker / 'leaked-from-tool').exists())

    def test_human_status_change_stops_publication(self):
        worker = runner.Runner(Mock(), self.repo, [], 60)
        worker.active_task = self.task['id']
        worker.tandem.project_call.return_value = {'version': 2, 'status': 'blocked'}
        with self.assertRaisesRegex(runner.ToolRefused, 'no longer in progress'):
            worker._phase('Pushing verified commit to main.')
