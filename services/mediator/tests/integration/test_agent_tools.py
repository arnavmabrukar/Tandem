"""Run only against a NEW empty database via TANDEM_AGENT_TOOLS_TEST_DATABASE_URL.

Applies every real migration, then drives the real MCP transport, authentication,
and PostgreSQL transactions using a real agent token.
"""
import hashlib
import logging
import os
import secrets
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

DSN = os.environ.get("TANDEM_AGENT_TOOLS_TEST_DATABASE_URL")
if DSN:
    os.environ["DATABASE_URL"] = DSN

MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations" / "versions"


@unittest.skipUnless(DSN, "Requires a new empty test database")
class AgentToolIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import psycopg
        from fastapi.testclient import TestClient
        from mediator.main import app

        with psycopg.connect(DSN) as connection:
            if connection.execute("SELECT to_regclass('public.users')").fetchone()[0]:
                raise RuntimeError("Refusing to run on a database with existing application tables")
        for migration in sorted(MIGRATIONS.glob("*.sql")):
            with psycopg.connect(DSN, autocommit=True) as connection:
                connection.execute(migration.read_text(encoding="utf-8"))

        logging.getLogger("httpx").setLevel(logging.WARNING)
        logging.disable(logging.INFO)
        cls.http = TestClient(app, base_url="http://127.0.0.1:8000").__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.http.__exit__(None, None, None)
        logging.disable(logging.NOTSET)

    def execute(self, sql, parameters=()):
        import psycopg
        with psycopg.connect(DSN) as connection:
            cursor = connection.execute(sql, parameters)
            return cursor.fetchall() if cursor.description else None

    def make_agent(self, owner, project, name, grant="active"):
        agent_id, token = str(uuid4()), "tdm_" + secrets.token_urlsafe(32)
        self.execute(
            """INSERT INTO public.agents (id, name, client, token_hash, owner, owner_user_id,
                                          grant_status)
               VALUES (%s, %s, 'Claude Code', %s, 'Owner', %s, 'active')""",
            (agent_id, name, hashlib.sha256(token.encode()).hexdigest(), owner),
        )
        self.execute(
            """INSERT INTO public.agent_project_grants
                   (project_id, agent_id, owner_user_id, status, granted_by)
               VALUES (%s, %s, %s, %s, %s)""",
            (project, agent_id, owner, grant, owner),
        )
        return agent_id, token

    def setUp(self):
        self.owner, self.project = str(uuid4()), str(uuid4())
        self.execute(
            """INSERT INTO public.users (id, auth_issuer, auth_subject, name)
               VALUES (%s, 'issuer', %s, 'Owner')""",
            (self.owner, self.owner),
        )
        self.execute(
            "INSERT INTO public.projects (id, name, repository) VALUES (%s, 'Test project', 'owner/repo')",
            (self.project,),
        )
        self.execute(
            "INSERT INTO public.project_memberships (project_id, user_id, role) VALUES (%s, %s, 'owner')",
            (self.project, self.owner),
        )
        self.agent, self.token = self.make_agent(self.owner, self.project, f"Agent {uuid4()}")

    def make_task(self, title="Task", review="approved", status="open", depends_on=()):
        task = str(uuid4())
        self.execute(
            """INSERT INTO public.tasks (id, project_id, created_by, title, contract_summary, status)
               VALUES (%s, %s, %s, %s, %s, %s)""",
            (task, self.project, self.owner, title, title, status),
        )
        if review is not None:
            decided = review in ("approved", "rejected")
            self.execute(
                """INSERT INTO public.contract_approvals
                       (project_id, task_id, repository, task_version, contract_version,
                        contract_summary, status, decided_by, decided_by_name, decided_at, note)
                   VALUES (%s, %s, 'owner/repo', 1, 1, %s, %s, %s, %s,
                           CASE WHEN %s THEN now() END, %s)""",
                (self.project, task, title, review, self.owner if decided else None,
                 "Owner" if decided else None, decided, "Reviewed" if decided else None),
            )
        for prerequisite in depends_on:
            self.execute(
                """INSERT INTO public.task_dependencies (project_id, task_id, depends_on_task_id)
                   VALUES (%s, %s, %s)""",
                (self.project, task, prerequisite),
            )
        return task

    def call(self, tool, token=None, **arguments):
        response = self.http.post("/mcp/", headers={
            "Authorization": f"Bearer {token or self.token}",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-03-26",
        }, json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                 "params": {"name": tool, "arguments": {"projectId": self.project, **arguments}}})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["result"]

    def ok(self, tool, token=None, **arguments):
        result = self.call(tool, token, **arguments)
        self.assertFalse(result.get("isError"), result)
        return result["structuredContent"]

    def refused(self, text, tool, token=None, **arguments):
        result = self.call(tool, token, **arguments)
        self.assertTrue(result.get("isError"), result)
        self.assertIn(text, result["content"][0]["text"])

    def claim(self, task, token=None, version=1):
        return dict(taskId=task, expectedVersion=version, operationId=str(uuid4()))

    def project_version(self):
        return self.execute("SELECT version FROM public.projects WHERE id = %s", (self.project,))[0][0]

    def workspace_project(self):
        from mediator.db.workspace import load_workspace
        workspace = load_workspace("issuer", self.owner)
        projects = workspace["projects"] if isinstance(workspace, dict) else workspace
        return next(project for project in projects if project["id"] == self.project)

    def test_plan_submission_is_attributed_and_idempotent(self):
        proposal = {"goal": "Ship feature", "summary": "Implement and verify", "tasks": [
            {"key": "build", "title": "Build", "contractSummary": "Implement feature",
             "criteria": ["Tests pass"]}]}
        args = {"operationId": str(uuid4()), "proposal": proposal}
        first = self.ok("tandem_propose_plan", **args)
        self.assertEqual(first, self.ok("tandem_propose_plan", **args))
        self.assertEqual(first["status"], "draft")
        row = self.execute("SELECT source,submitted_by_agent_id,created_by::text FROM public.plan_proposal_revisions WHERE plan_id=%s", (first["planId"],))[0]
        self.assertEqual(row, ("agent", self.agent, self.owner))
        self.assertEqual(self.execute("SELECT count(*) FROM public.tasks WHERE project_id=%s", (self.project,))[0][0], 0)
        self.refused("already used", "tandem_propose_plan", **(args | {"proposal": proposal | {"goal": "Changed"}}))
        # A revoked grant must not retrieve a previously successful operation.
        self.execute("UPDATE public.agent_project_grants SET status='revoked' WHERE agent_id=%s", (self.agent,))
        from mediator.db.agent_plans import propose_plan
        from mediator.db.agent_tasks import AgentAccessDenied
        from mediator.schemas.plans import PlanProposal
        from uuid import UUID
        # Also exercise the transaction's live check without transport filtering.
        with self.assertRaises(AgentAccessDenied):
            propose_plan({"agentId": self.agent, "ownerId": self.owner},
                         UUID(self.project), UUID(args["operationId"]), PlanProposal.model_validate(proposal))

    def test_plan_submission_rejects_cycles_and_viewers(self):
        proposal = {"goal": "Ship", "summary": "Scope", "tasks": [
            {"key": "build", "title": "Build", "contractSummary": "Scope",
             "criteria": ["Works"], "dependencies": ["build"]}]}
        result = self.call("tandem_propose_plan", operationId=str(uuid4()), proposal=proposal)
        self.assertTrue(result.get("isError"), result)
        proposal["tasks"][0]["dependencies"] = []
        self.execute("UPDATE public.project_memberships SET role='viewer' WHERE project_id=%s AND user_id=%s", (self.project, self.owner))
        self.refused("cannot change", "tandem_propose_plan", operationId=str(uuid4()), proposal=proposal)
        self.assertEqual(self.execute("SELECT count(*) FROM public.plan_proposals WHERE project_id=%s", (self.project,))[0][0], 0)

    def test_full_work_cycle_appears_on_the_dashboard(self):
        task = self.make_task("Build it")
        listed = self.ok("tandem_list_tasks")
        self.assertEqual(listed["project"]["repository"], "owner/repo")
        self.assertTrue(listed["tasks"][0]["claimable"])

        before = self.project_version()
        claimed = self.ok("tandem_claim_task", **self.claim(task))
        self.assertEqual((claimed["status"], claimed["taskVersion"]), ("claimed", 2))
        self.assertEqual(self.project_version(), before + 1)

        for version, status in ((2, "in_progress"), (3, "in_review")):
            self.ok("tandem_update_task", taskId=task, expectedVersion=version,
                    operationId=str(uuid4()), status=status, progress=f"Now {status}")
        self.ok("tandem_post_message", taskId=task, type="result", body="All done",
                operationId=str(uuid4()))

        detail = self.ok("tandem_get_task", taskId=task)
        self.assertEqual(detail["status"], "in_review")
        self.assertEqual(detail["progress"], "Now in_review")
        self.assertEqual(detail["claimedByAgentId"], self.agent)
        self.assertEqual(detail["messages"][0]["body"], "All done")

        project = self.workspace_project()
        self.assertEqual(project["tasks"][0]["agentId"], self.agent)
        self.assertEqual(project["messages"][0]["type"], "result")
        self.assertTrue(project["messages"][0]["sender"].startswith("Agent "))
        self.assertEqual([event["kind"] for event in project["activity"]],
                         ["task_claimed", "task_status_changed", "task_status_changed"])
        self.assertTrue(project["activity"][0]["actor"].startswith("Agent "))

    def test_claim_follows_the_real_human_create_and_approve_flow(self):
        from mediator.db.approvals import decide_contract
        from mediator.db.projects import ProjectVersionConflict
        from mediator.db.tasks import cancel_task, create_task
        from mediator.schemas.approvals import DecideContractRequest
        from mediator.schemas.tasks import CancelTaskRequest, CreateTaskRequest

        created = create_task(self.owner, self.project, CreateTaskRequest(
            operationId=uuid4(), expectedVersion=self.project_version(), title="Reviewed work",
            description="", agentId=None, paths=[], criteria=[], dependencies=[],
        ))
        task = str(created.entityId)
        self.refused("waiting for human approval", "tandem_claim_task", **self.claim(task))

        approval = self.execute(
            "SELECT id FROM public.contract_approvals WHERE task_id = %s", (task,))[0][0]
        decide_contract(self.owner, self.project, approval, DecideContractRequest(
            operationId=uuid4(), expectedVersion=self.project_version(), decision="approved",
            note="Looks right", target={"action": "Approve contract", "repository": "owner/repo",
                                        "taskVersion": 1, "contractVersion": 1, "head": None},
        ))
        self.ok("tandem_claim_task", **self.claim(task))

        # Agent writes bump the project version, so a human holding an old
        # version is told to reload rather than overwriting newer state.
        kinds = [event["kind"] for event in self.workspace_project()["activity"]]
        self.assertEqual(kinds, ["task_created", "task_claimed"])
        with self.assertRaises(ProjectVersionConflict):
            cancel_task(self.owner, self.project, task, CancelTaskRequest(
                operationId=uuid4(), expectedVersion=1))

    def test_claim_requires_an_approved_contract(self):
        for review, text in (("pending", "waiting for human approval"),
                             ("rejected", "rejected"), (None, "no approved review")):
            with self.subTest(review=review):
                task = self.make_task(review=review)
                before = self.project_version()
                self.refused(text, "tandem_claim_task", **self.claim(task))
                self.assertEqual(self.project_version(), before)
                status = self.execute("SELECT status FROM public.tasks WHERE id = %s", (task,))[0][0]
                self.assertEqual(status, "open")

    def test_claim_requires_finished_dependencies(self):
        first = self.make_task("First")
        second = self.make_task("Second", depends_on=[first])
        self.refused("Waiting for dependency 'First'", "tandem_claim_task", **self.claim(second))
        self.execute("UPDATE public.tasks SET status = 'merged' WHERE id = %s", (first,))
        self.ok("tandem_claim_task", **self.claim(second))

    def test_only_one_of_two_simultaneous_claims_wins(self):
        task = self.make_task()
        _, other_token = self.make_agent(self.owner, self.project, f"Agent {uuid4()}")
        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(lambda token: self.call(
                "tandem_claim_task", token, **self.claim(task)), (self.token, other_token)))
        self.assertEqual(sorted(bool(result.get("isError")) for result in results), [False, True])
        version = self.execute("SELECT version FROM public.tasks WHERE id = %s", (task,))[0][0]
        self.assertEqual(version, 2)

    def test_stale_task_version_is_refused(self):
        task = self.make_task()
        self.refused("reload before claiming", "tandem_claim_task", **self.claim(task, version=7))

    def test_retry_replays_without_repeating_and_reuse_conflicts(self):
        task = self.make_task()
        arguments = self.claim(task)
        first = self.ok("tandem_claim_task", **arguments)
        version = self.project_version()
        self.assertEqual(self.ok("tandem_claim_task", **arguments), first)
        self.assertEqual(self.project_version(), version)

        other = self.make_task()
        self.refused("already used", "tandem_claim_task",
                     **{**arguments, "taskId": other})

        message = dict(taskId=task, type="status", body="Once", operationId=str(uuid4()))
        self.assertEqual(self.ok("tandem_post_message", **message),
                         self.ok("tandem_post_message", **message))
        self.assertEqual(len(self.ok("tandem_get_task", taskId=task)["messages"]), 1)

    def test_only_the_claim_holder_can_update(self):
        task = self.make_task()
        _, other_token = self.make_agent(self.owner, self.project, f"Agent {uuid4()}")
        self.ok("tandem_claim_task", **self.claim(task))
        self.refused("holding the claim", "tandem_update_task", other_token, taskId=task,
                     expectedVersion=2, operationId=str(uuid4()), progress="Mine now")

    def test_status_changes_follow_allowed_transitions(self):
        task = self.make_task()
        self.ok("tandem_claim_task", **self.claim(task))
        self.refused("Cannot move", "tandem_update_task", taskId=task, expectedVersion=2,
                     operationId=str(uuid4()), status="in_review")
        # A human accepting the work ends the agent's control over the task.
        self.execute("UPDATE public.tasks SET status = 'approved' WHERE id = %s", (task,))
        self.refused("cannot change", "tandem_update_task", taskId=task, expectedVersion=2,
                     operationId=str(uuid4()), progress="Still going")

    def test_viewer_owner_can_read_but_not_write(self):
        task = self.make_task()
        self.execute("UPDATE public.project_memberships SET role = 'viewer' WHERE project_id = %s",
                     (self.project,))
        self.ok("tandem_list_tasks")
        self.refused("cannot change this project", "tandem_claim_task", **self.claim(task))
        self.refused("cannot change this project", "tandem_post_message", taskId=task, type="status",
                     body="Hello", operationId=str(uuid4()))

    def test_revoked_grant_loses_access_immediately(self):
        self.make_task()
        self.ok("tandem_list_tasks")
        self.execute("UPDATE public.agent_project_grants SET status = 'revoked' WHERE agent_id = %s",
                     (self.agent,))
        response = self.http.post("/mcp/", headers={
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-03-26",
        }, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
        self.assertEqual(response.status_code, 401)

    def test_reply_must_belong_to_the_same_task(self):
        first, second = self.make_task("First"), self.make_task("Second")
        posted = self.ok("tandem_post_message", taskId=first, type="question", body="Why?",
                         operationId=str(uuid4()))
        self.refused("Reply target", "tandem_post_message", taskId=second, type="answer",
                     body="Because", operationId=str(uuid4()), replyTo=posted["messageId"])
        self.ok("tandem_post_message", taskId=first, type="answer", body="Because",
                operationId=str(uuid4()), replyTo=posted["messageId"])

    def test_presence_follows_check_ins(self):
        def presence():
            return self.workspace_project()["agents"][0]["presence"]

        self.assertEqual(presence(), "offline")
        self.ok("tandem_status")
        self.assertEqual(presence(), "online")
        self.assertIsNotNone(self.workspace_project()["agents"][0]["lastSeen"])

        for age, expected in (("5 minutes", "stale"), ("1 hour", "offline")):
            self.execute("UPDATE public.agents SET last_seen_at = now() - %s::interval WHERE id = %s",
                         (age, self.agent))
            self.assertEqual(presence(), expected)

        self.ok("tandem_status")
        self.execute("UPDATE public.agent_project_grants SET status = 'revoked' WHERE agent_id = %s",
                     (self.agent,))
        self.assertEqual(presence(), "offline")

    def test_check_ins_are_throttled(self):
        def last_seen():
            return self.execute("SELECT last_seen_at FROM public.agents WHERE id = %s", (self.agent,))[0][0]

        self.ok("tandem_status")
        first = last_seen()
        self.ok("tandem_status")
        self.assertEqual(last_seen(), first)
        self.execute("UPDATE public.agents SET last_seen_at = now() - interval '31 seconds' WHERE id = %s",
                     (self.agent,))
        self.ok("tandem_status")
        self.assertGreater(last_seen(), first)


if __name__ == "__main__":
    unittest.main()
