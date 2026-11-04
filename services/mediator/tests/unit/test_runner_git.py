"""Exercise branch isolation and agent conflict resolution using real local Git repositories."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location(
    'runner_git', Path(__file__).resolve().parents[4] / 'agent-integrations/runner/tandem_runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class RunnerLoginCheckTests(unittest.TestCase):
    def test_login_check_launches_the_resolved_executable(self):
        # On Windows, npm installs claude as claude.cmd, which only the resolved path can launch.
        repo = Mock()
        repo.dirty.return_value = False
        repo.exists.return_value = True
        repo.base_branch.return_value = 'main'
        with patch.object(runner.shutil, 'which', side_effect=lambda name, **_: rf'C:\npm\{name}.CMD'), \
                patch.object(runner.subprocess, 'run', return_value=Mock(returncode=0)) as run:
            runner.check_worker(repo, ['claude', '-p'], False)
        self.assertEqual(run.call_args_list[0].args[0], [r'C:\npm\claude.CMD', 'auth', 'status'])


class RunnerGitTests(unittest.TestCase):
    def setUp(self):
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
            self.commit(self.worker, 'Resolve integration conflict')
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
        worker = runner.Runner(Mock(), self.repo, ['fake-agent'], 60, open_pull_requests=False)

        def agent(prompt):
            if 'Integration step:' in prompt:
                (self.worker / 'shared.txt').write_text('agent change\nteammate change\n')
                self.commit(self.worker, 'Resolve conflict')
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
        branch = runner.branch_name(self.task)
        self.assertIn(branch, result['progress'])
        self.assertTrue(self.repo.contains('origin/main'))
        self.assertEqual(self.repo.git('rev-parse', f'origin/{branch}'), self.repo.git('rev-parse', 'HEAD'))
        self.assertEqual(self.git(self.source, 'show', 'origin/main:shared.txt'), 'teammate change')

    def test_review_refresh_resolves_conflict_without_redoing_the_task(self):
        branch = self.make_conflict()
        self.repo.git('push', '-u', 'origin', branch)
        worker = runner.Runner(Mock(), self.repo, ['fake-agent'], 60, open_pull_requests=False)

        def agent(prompt):
            if 'Integration step:' in prompt:
                (self.worker / 'shared.txt').write_text('agent change\nteammate change\n')
                self.commit(self.worker, 'Resolve review conflict')
            else:
                self.assertIn('Review update:', prompt)
            return 0, 'Validated the combined result.'

        with patch.object(worker, '_run_agent_with_keepalive', side_effect=agent):
            worker._execute(self.task, review_refresh=True)
        self.assertTrue(self.repo.contains('origin/main'))
        self.assertFalse(self.repo.dirty())

    def test_automatic_download_shares_one_clone_between_agents(self):
        actual_run = subprocess.run
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
             patch.object(runner.shutil, 'which', return_value='/bin/tool'), \
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
        with patch.object(runner.Path, 'home', return_value=self.root / 'home'), \
             patch.object(runner.Path, 'cwd', return_value=self.source), \
             patch.object(runner.shutil, 'which', return_value='/bin/tool'), \
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

    def test_conflicting_review_pr_is_revisited_but_merged_pr_is_not(self):
        task = {**self.task, 'status': 'in_review'}
        tandem = Mock()
        tandem.project_call.side_effect = lambda tool, **kw: {'presenceRequests': []} if tool == 'tandem_get_presence_requests' else {'tasks': [task]}
        worker = runner.Runner(tandem, self.repo, [], 60)
        for state, expected in [('OPEN', task), ('MERGED', None), ('CLOSED', None)]:
            with patch.object(runner.subprocess, 'run', return_value=Mock(
                    returncode=0, stdout=json.dumps({'state': state, 'mergeable': 'CONFLICTING'}))):
                self.assertEqual(worker.next_task(), expected)
