"""Run only against a NEW empty database via TANDEM_FLOW_TEST_DATABASE_URL.

Drives the whole chain with no mocks except the coding agent: a real server, real MCP
calls, real git pushes to a local remote, and the real dispatcher and runner code.
"""
import hashlib
import importlib.util
import os
import secrets
import socket
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path
from uuid import uuid4

DSN = os.environ.get("TANDEM_FLOW_TEST_DATABASE_URL")
if DSN:
    os.environ["DATABASE_URL"] = DSN

ROOT = Path(__file__).resolve().parents[4]
MIGRATIONS = ROOT / "services/mediator/migrations/versions"

# Stands in for the coding agent: reads the prompt, commits a file, prints a summary.
FAKE_AGENT = """
import pathlib, subprocess, sys, uuid
prompt = sys.stdin.read()
pathlib.Path(f"work-{uuid.uuid4().hex}.txt").write_text(prompt, encoding="utf-8")
subprocess.run(["git", "add", "-A"], check=True)
subprocess.run(["git", "-c", "user.name=Agent", "-c", "user.email=agent@example.com",
                "commit", "-m", "Do the task"], check=True, capture_output=True)
print("Finished the task")
"""
FAILING_AGENT = 'import sys; sys.stdin.read(); print("Could not do it"); sys.exit(3)'
IDLE_AGENT = 'import sys; sys.stdin.read(); print("Nothing to do")'


def load_runner():
    spec = importlib.util.spec_from_file_location(
        "tandem_runner", ROOT / "agent-integrations/runner/tandem_runner.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["tandem_runner"] = module
    spec.loader.exec_module(module)
    return module


def git(*args, cwd):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def remove_tree(path):
    # Git marks object files read-only, which blocks deletion on Windows.
    def retry(function, target, _):
        os.chmod(target, stat.S_IWRITE)
        function(target)
    import shutil
    shutil.rmtree(path, onerror=retry)


@unittest.skipUnless(DSN, "Requires a new empty test database")
class AutonomousFlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import psycopg
        with psycopg.connect(DSN) as connection:
            if connection.execute("SELECT to_regclass('public.users')").fetchone()[0]:
                raise RuntimeError("Refusing to run on a database with existing application tables")
        for migration in sorted(MIGRATIONS.glob("*.sql")):
            with psycopg.connect(DSN, autocommit=True) as connection:
                connection.execute(migration.read_text(encoding="utf-8"))
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            cls.port = probe.getsockname()[1]
        # This test runs the dispatcher itself so that each step is deterministic.
        cls.server = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "mediator.main:app", "--port", str(cls.port), "--log-level", "warning"],
            env={**os.environ, "DATABASE_URL": DSN, "TANDEM_DISPATCH_ENABLED": "false",
                 "PYTHONPATH": str(ROOT / "services/mediator/src")},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        cls.url = f"http://127.0.0.1:{cls.port}/mcp/"
        for _ in range(60):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{cls.port}/health", timeout=2)
                break
            except OSError:
                time.sleep(0.5)
        else:
            cls.server.kill()
            raise RuntimeError("Test server did not start")
        cls.runner_module = load_runner()

    @classmethod
    def tearDownClass(cls):
        cls.server.kill()
        cls.server.wait()

    def execute(self, sql, parameters=()):
        import psycopg
        with psycopg.connect(DSN) as connection:
            cursor = connection.execute(sql, parameters)
            return cursor.fetchall() if cursor.description else None

    def setUp(self):
        from uuid import UUID
        self.owner, self.project = uuid4(), uuid4()
        self.execute("INSERT INTO public.users (id, auth_issuer, auth_subject, name) VALUES (%s, 'issuer', %s, 'Owner')",
                     (self.owner, str(self.owner)))
        self.execute("INSERT INTO public.projects (id, name, repository) VALUES (%s, 'Flow', 'owner/repo')", (self.project,))
        self.execute("INSERT INTO public.project_memberships (project_id, user_id, role) VALUES (%s, %s, 'owner')",
                     (self.project, self.owner))
        self.addCleanup(self.stop_other_projects)

        self.temp = Path(tempfile.mkdtemp())
        self.addCleanup(remove_tree, self.temp)
        remote = self.temp / "remote.git"
        git("init", "--bare", "-b", "main", str(remote), cwd=self.temp)
        self.clone = self.temp / "clone"
        git("clone", str(remote), str(self.clone), cwd=self.temp)
        git("checkout", "-b", "main", cwd=self.clone)
        (self.clone / "README.md").write_text("start\n")
        git("add", "-A", cwd=self.clone)
        git("-c", "user.name=Owner", "-c", "user.email=owner@example.com", "commit", "-m", "Start", cwd=self.clone)
        git("push", "-u", "origin", "main", cwd=self.clone)
        self.remote = remote

        self.agent, self.token = self.make_agent()
        self.runner = self.make_runner(self.token, self.agent_script("agent.py", FAKE_AGENT))

    def stop_other_projects(self):
        self.execute("UPDATE public.projects SET auto_delegate = false WHERE id = %s", (self.project,))

    def agent_script(self, name, source):
        script = self.temp / name
        script.write_text(source, encoding="utf-8")
        return [sys.executable, str(script)]

    def make_agent(self, seen=True):
        agent_id, token = str(uuid4()), "tdm_" + secrets.token_urlsafe(32)
        self.execute(
            """INSERT INTO public.agents (id, name, client, token_hash, owner, owner_user_id, grant_status, last_seen_at)
               VALUES (%s, %s, 'Claude Code', %s, 'Owner', %s, 'active', CASE WHEN %s THEN now() END)""",
            (agent_id, f"Agent {agent_id[:8]}", hashlib.sha256(token.encode()).hexdigest(), self.owner, seen))
        self.execute(
            """INSERT INTO public.agent_project_grants (project_id, agent_id, owner_user_id, status, granted_by)
               VALUES (%s, %s, %s, 'active', %s)""", (self.project, agent_id, self.owner, self.owner))
        return agent_id, token

    def make_runner(self, token, command, clone=None):
        module = self.runner_module
        tandem = module.Tandem(self.url, token, str(self.project))
        return module.Runner(tandem, module.Repo(clone or self.clone), command, timeout=60, open_pull_requests=False)

    def project_version(self):
        return self.execute("SELECT version FROM public.projects WHERE id = %s", (self.project,))[0][0]

    def approve_plan(self, start_now=True):
        from mediator.db.plans import approve_plan, create_plan
        from mediator.schemas.plans import ApprovePlanRequest, CreatePlanRequest, PlanProposal
        proposal = PlanProposal(goal="Build a list", summary="Two steps", tasks=[
            {"key": "first", "title": "First step", "contractSummary": "Do first", "criteria": ["Works"]},
            {"key": "second", "title": "Second step", "contractSummary": "Do second", "criteria": ["Works"],
             "dependencies": ["first"]},
        ])
        saved = create_plan(self.owner, self.project, CreatePlanRequest(
            operationId=uuid4(), expectedVersion=self.project_version(), proposal=proposal))
        approved = approve_plan(self.owner, self.project, saved.planId, ApprovePlanRequest(
            operationId=uuid4(), expectedVersion=self.project_version(),
            expectedPlanVersion=saved.planVersion, note="Looks right", startNow=start_now))
        return approved.taskIds["first"], approved.taskIds["second"]

    def dispatch(self):
        from mediator.db.dispatch import dispatch_once
        return dispatch_once()

    def task(self, task_id):
        rows = self.execute(
            """SELECT status, assigned_agent_id, claimed_by_agent_id FROM public.tasks WHERE id = %s""", (task_id,))
        return rows[0]

    def review(self, task_id, decision, note=None):
        from mediator.db.task_review import review_task
        from mediator.schemas.task_review import ReviewTaskRequest
        return review_task(self.owner, self.project, task_id, ReviewTaskRequest(
            operationId=uuid4(), expectedVersion=self.project_version(), decision=decision, note=note))

    def release(self, task_id):
        from mediator.db.task_review import release_task
        from mediator.schemas.task_review import ReleaseTaskRequest
        return release_task(self.owner, self.project, task_id, ReleaseTaskRequest(
            operationId=uuid4(), expectedVersion=self.project_version()))

    def remote_branches(self):
        output = git("for-each-ref", "--format=%(refname:short)", "refs/heads", cwd=self.remote)
        return [line for line in output.splitlines() if line.startswith("tandem/")]

    def messages(self, task_id):
        return self.execute("SELECT type, body FROM public.messages WHERE task_id = %s ORDER BY sequence", (task_id,))

    def test_full_chain_runs_one_task_after_another(self):
        first, second = self.approve_plan()

        # Approve and run: one approval covers every contract and turns on delegation.
        reviews = self.execute("SELECT status, decided_by_name FROM public.contract_approvals WHERE project_id = %s",
                               (self.project,))
        self.assertEqual(reviews, [("approved", "Owner"), ("approved", "Owner")])

        # Only the first task is ready; the second waits for it.
        self.assertEqual(self.dispatch(), 1)
        self.assertEqual(self.task(first)[1], self.agent)
        self.assertIsNone(self.task(second)[1])

        # The runner does the work without any further human action.
        self.assertTrue(self.runner.run_once())
        self.assertEqual(self.task(first)[0], "in_review")
        self.assertEqual(self.task(first)[2], self.agent)
        self.assertEqual(len(self.remote_branches()), 1)
        kind, body = self.messages(first)[-1]
        self.assertEqual(kind, "result")
        self.assertIn("Finished the task", body)

        # Work waiting on a person is left alone, and the next task stays locked.
        self.assertFalse(self.runner.run_once())
        self.assertEqual(self.dispatch(), 0)
        self.assertIsNone(self.task(second)[1])

        # A reviewer's note reaches the agent, on the same branch, in the next attempt.
        self.review(first, "request_changes", "Please also handle empty lists")
        self.assertEqual(self.task(first)[0], "in_progress")
        self.assertTrue(self.runner.run_once())
        self.assertEqual(self.task(first)[0], "in_review")
        self.assertEqual(len(self.remote_branches()), 1)
        branch = self.remote_branches()[0]
        files = git("ls-tree", "--name-only", branch, cwd=self.remote).splitlines()
        attempts = [name for name in files if name.startswith("work-")]
        self.assertEqual(len(attempts), 2)
        contents = [git("show", f"{branch}:{name}", cwd=self.remote) for name in attempts]
        self.assertTrue(any("Please also handle empty lists" in text for text in contents))

        # Accepting finishes the task and unlocks the next one automatically.
        self.review(first, "accept")
        self.assertEqual(self.task(first)[0], "approved")
        self.assertEqual(self.dispatch(), 1)
        self.assertEqual(self.task(second)[1], self.agent)
        self.assertTrue(self.runner.run_once())
        self.assertEqual(self.task(second)[0], "in_review")
        self.review(second, "accept")
        self.assertEqual(self.task(second)[0], "approved")
        self.assertFalse(self.runner.run_once())

    def test_plain_approval_still_requires_contract_review(self):
        self.approve_plan(start_now=False)
        statuses = self.execute("SELECT status FROM public.contract_approvals WHERE project_id = %s", (self.project,))
        self.assertEqual(statuses, [("pending",), ("pending",)])
        self.assertEqual(self.execute("SELECT auto_delegate FROM public.projects WHERE id = %s", (self.project,)), [(False,)])
        self.assertEqual(self.dispatch(), 0)

    def test_failed_agent_blocks_the_task_and_can_be_retried(self):
        first, _ = self.approve_plan()
        self.dispatch()
        failing = self.make_runner(self.token, self.agent_script("fail.py", FAILING_AGENT))
        self.assertTrue(failing.run_once())
        self.assertEqual(self.task(first)[0], "blocked")
        self.assertIn("Could not do it", self.messages(first)[-1][1])
        self.assertEqual(self.remote_branches(), [])
        # A blocked task is not retried until a person acts.
        self.assertFalse(self.runner.run_once())
        self.review(first, "request_changes", "Try again")
        self.assertTrue(self.runner.run_once())
        self.assertEqual(self.task(first)[0], "in_review")

    def test_agent_that_commits_nothing_is_blocked(self):
        first, _ = self.approve_plan()
        self.dispatch()
        idle = self.make_runner(self.token, self.agent_script("idle.py", IDLE_AGENT))
        self.assertTrue(idle.run_once())
        self.assertEqual(self.task(first)[0], "blocked")
        self.assertIn("without committing", self.messages(first)[-1][1])

    def test_dirty_clone_blocks_instead_of_mixing_work(self):
        first, _ = self.approve_plan()
        self.dispatch()
        (self.clone / "stray.txt").write_text("not mine")
        self.assertTrue(self.runner.run_once())
        self.assertEqual(self.task(first)[0], "blocked")
        self.assertIn("uncommitted", self.messages(first)[-1][1])

    def test_agent_never_receives_the_token(self):
        first, _ = self.approve_plan()
        self.dispatch()
        source = ('import os, subprocess, sys; sys.stdin.read(); '
                  'open("env.txt", "w").write(os.environ.get("TANDEM_AGENT_TOKEN", "absent")); '
                  'subprocess.run(["git", "add", "-A"]); '
                  'subprocess.run(["git", "-c", "user.name=A", "-c", "user.email=a@example.com", "commit", "-m", "x"])')
        os.environ["TANDEM_AGENT_TOKEN"] = self.token
        self.addCleanup(os.environ.pop, "TANDEM_AGENT_TOKEN", None)
        runner = self.make_runner(self.token, self.agent_script("env.py", source))
        self.assertTrue(runner.run_once())
        branch = self.remote_branches()[0]
        self.assertEqual(git("show", f"{branch}:env.txt", cwd=self.remote), "absent")

    def test_offline_agents_get_no_work_and_stale_assignments_return(self):
        self.execute("UPDATE public.agents SET last_seen_at = now() - interval '1 hour' WHERE id = %s", (self.agent,))
        first, _ = self.approve_plan()
        self.assertEqual(self.dispatch(), 0)
        self.assertIsNone(self.task(first)[1])

        self.execute("UPDATE public.agents SET last_seen_at = now() WHERE id = %s", (self.agent,))
        self.assertEqual(self.dispatch(), 1)
        self.execute("UPDATE public.agents SET last_seen_at = now() - interval '20 minutes' WHERE id = %s", (self.agent,))
        other, _ = self.make_agent()
        self.assertEqual(self.dispatch(), 1)
        self.assertEqual(self.task(first)[1], other)

    def test_people_chosen_assignments_and_claims_are_not_taken_back(self):
        from mediator.db.assignments import assign_task
        from mediator.schemas.assignments import AssignTaskRequest
        first, _ = self.approve_plan()
        assign_task(self.owner, self.project, first, AssignTaskRequest(
            operationId=uuid4(), expectedVersion=self.project_version(), agentId=self.agent))
        self.execute("UPDATE public.agents SET last_seen_at = now() - interval '1 hour' WHERE id = %s", (self.agent,))
        self.dispatch()
        self.assertEqual(self.task(first)[1], self.agent)

        self.execute("UPDATE public.tasks SET claimed_by_agent_id = %s, status = 'claimed', auto_assigned = true WHERE id = %s",
                     (self.agent, first))
        self.dispatch()
        self.assertEqual(self.task(first)[2], self.agent)

    def test_release_requeues_and_stops_the_old_agent(self):
        first, _ = self.approve_plan()
        self.dispatch()
        self.assertTrue(self.runner.run_once())
        self.assertEqual(self.release(first).status, "open")
        self.assertEqual(self.task(first), ("open", None, None))
        other, other_token = self.make_agent()
        self.execute("UPDATE public.agents SET last_seen_at = now() - interval '1 hour' WHERE id = %s", (self.agent,))
        self.assertEqual(self.dispatch(), 1)
        self.assertEqual(self.task(first)[1], other)
        # The contract stays approved, so the new agent can claim straight away.
        second_clone = self.temp / "clone2"
        git("clone", str(self.remote), str(second_clone), cwd=self.temp)
        runner = self.make_runner(other_token, self.agent_script("agent2.py", FAKE_AGENT), clone=second_clone)
        self.assertTrue(runner.run_once())
        self.assertEqual(self.task(first)[2], other)

    def test_invalid_decisions_are_refused(self):
        from mediator.db import agent_tasks
        first, _ = self.approve_plan()
        for action in (lambda: self.review(first, "accept"),
                       lambda: self.review(first, "request_changes", "Change it"),
                       lambda: self.release(first)):
            with self.assertRaises(agent_tasks.AgentTaskConflict):
                action()
        self.assertEqual(self.task(first)[0], "open")

    def test_viewers_cannot_decide(self):
        from mediator.db.projects import ProjectAccessDenied
        first, _ = self.approve_plan()
        self.execute("UPDATE public.project_memberships SET role = 'viewer' WHERE project_id = %s", (self.project,))
        with self.assertRaises(ProjectAccessDenied):
            self.release(first)


if __name__ == "__main__":
    unittest.main()
