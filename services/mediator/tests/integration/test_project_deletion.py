"""Run only against a NEW empty database via TANDEM_DELETION_TEST_DATABASE_URL.

Fills a project through the real code paths, deletes it, then scans EVERY table's
full text for anything left behind, so a table added later can't be missed silently.
"""
import hashlib
import os
import secrets
import unittest
from pathlib import Path
from uuid import UUID, uuid4

DSN = os.environ.get("TANDEM_DELETION_TEST_DATABASE_URL")
if DSN:
    os.environ["DATABASE_URL"] = DSN

MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations" / "versions"
SECRET_TEXT = "ZZSENTINELZZ"


@unittest.skipUnless(DSN, "Requires a new empty test database")
class ProjectDeletionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import psycopg
        with psycopg.connect(DSN) as connection:
            if connection.execute("SELECT to_regclass('public.users')").fetchone()[0]:
                raise RuntimeError("Refusing to run on a database with existing application tables")
        for migration in sorted(MIGRATIONS.glob("*.sql")):
            with psycopg.connect(DSN, autocommit=True) as connection:
                connection.execute(migration.read_text(encoding="utf-8"))

    def execute(self, sql, parameters=()):
        import psycopg
        with psycopg.connect(DSN) as connection:
            cursor = connection.execute(sql, parameters)
            return cursor.fetchall() if cursor.description else None

    def make_user(self, name="Owner"):
        user = uuid4()
        self.execute("INSERT INTO public.users (id, auth_issuer, auth_subject, name) VALUES (%s, 'issuer', %s, %s)",
                     (user, str(user), name))
        return user

    def make_project(self, owner, marker=SECRET_TEXT):
        project = uuid4()
        self.execute("INSERT INTO public.projects (id, name, repository, description) VALUES (%s, %s, 'owner/repo', %s)",
                     (project, f"{marker} project", f"{marker} description"))
        self.execute("INSERT INTO public.project_memberships (project_id, user_id, role) VALUES (%s, %s, 'owner')",
                     (project, owner))
        return project

    def version(self, project):
        return self.execute("SELECT version FROM public.projects WHERE id = %s", (project,))[0][0]

    def register(self, owner, project, name="Claude Code"):
        from mediator.db.agents import register_agent
        from mediator.schemas.agents import RegisterAgentRequest
        return register_agent(owner, project, RegisterAgentRequest(
            operationId=uuid4(), expectedVersion=self.version(project), name=name,
            client="Claude Code", owner="", machine="", capabilities=[])).entityId

    def activate(self, owner, project, agent):
        token = "tdm_" + secrets.token_urlsafe(32)
        self.execute("UPDATE public.agents SET grant_status = 'active', token_hash = %s WHERE id = %s",
                     (hashlib.sha256(token.encode()).hexdigest(), agent))
        self.execute("UPDATE public.agent_project_grants SET status = 'active' WHERE agent_id = %s", (agent,))
        return {"agentId": str(agent), "ownerId": str(owner), "name": "Agent", "client": "Claude Code",
                "projects": [{"projectId": str(project), "name": "P", "ownerRole": "owner"}]}, token

    def fill(self, owner, project, marker=SECRET_TEXT):
        """Create project data in every table through the real write paths."""
        from mediator.db import agent_tasks
        from mediator.db.approvals import decide_contract
        from mediator.db.invitations import create_invitation
        from mediator.db.messages import create_message
        from mediator.db.plans import approve_plan, create_plan
        from mediator.db.tasks import create_task
        from mediator.schemas.approvals import DecideContractRequest
        from mediator.schemas.invitations import CreateInvitationRequest
        from mediator.schemas.messages import CreateMessageRequest
        from mediator.schemas.plans import ApprovePlanRequest, CreatePlanRequest, PlanProposal
        from mediator.schemas.tasks import CreateTaskRequest

        agent = self.register(owner, project, f"{marker} agent")
        identity, token = self.activate(owner, project, agent)

        task = create_task(owner, project, CreateTaskRequest(
            operationId=uuid4(), expectedVersion=self.version(project), title=f"{marker} task",
            description=f"{marker} details", agentId=None, paths=[], criteria=[f"{marker} criterion"], dependencies=[],
        )).entityId
        create_message(owner, project, task, CreateMessageRequest(
            operationId=uuid4(), expectedVersion=self.version(project), body=f"{marker} note", replyTo=None))
        approval = self.execute("SELECT id FROM public.contract_approvals WHERE task_id = %s", (task,))[0][0]
        decide_contract(owner, project, approval, DecideContractRequest(
            operationId=uuid4(), expectedVersion=self.version(project), decision="approved", note=f"{marker} review",
            target={"action": "Approve contract", "repository": "owner/repo",
                    "taskVersion": 1, "contractVersion": 1, "head": None}))
        agent_tasks.claim_task(identity, project, task, 1, uuid4())
        agent_tasks.post_message(identity, project, task, "status", f"{marker} agent message", uuid4())
        self.execute(
            """INSERT INTO public.agent_room_exchanges
               (project_id, sender_user_id, sender_name, operation_id, body, lease, lease_until)
               VALUES (%s, %s, 'Owner', %s, %s, %s, now())""",
            (project, owner, uuid4(), f"{marker} room message", uuid4()),
        )
        self.execute(
            """INSERT INTO public.agent_room_exchanges
               (project_id, sender_agent_id, sender_name, operation_id, body, lease, lease_until)
               VALUES (%s, %s, 'Agent', %s, %s, %s, now())""",
            (project, agent, uuid4(), f"{marker} agent room reply", uuid4()),
        )

        proposal = PlanProposal(goal=f"{marker} goal", summary=f"{marker} summary", tasks=[
            {"key": "one", "title": f"{marker} planned", "contractSummary": f"{marker} scope", "criteria": ["Works"]},
            {"key": "two", "title": f"{marker} next", "contractSummary": f"{marker} scope", "criteria": ["Works"],
             "dependencies": ["one"]}])
        saved = create_plan(owner, project, CreatePlanRequest(
            operationId=uuid4(), expectedVersion=self.version(project), proposal=proposal))
        approve_plan(owner, project, saved.planId, ApprovePlanRequest(
            operationId=uuid4(), expectedVersion=self.version(project), expectedPlanVersion=saved.planVersion,
            note=f"{marker} plan note", startNow=True))
        create_invitation(owner, project, CreateInvitationRequest(
            operationId=uuid4(), expectedVersion=self.version(project),
            email=f"{marker.lower()}@example.com", role="reviewer"))

        self.execute(
            """INSERT INTO public.mcp_oauth_clients (id, metadata) VALUES (%s, '{}')""", (f"client-{uuid4()}",))
        client = self.execute("SELECT id FROM public.mcp_oauth_clients LIMIT 1")[0][0]
        session = self.execute(
            """INSERT INTO public.mcp_oauth_sessions (client_id, owner_id, project_id, agent_id, resource, expires_at)
               VALUES (%s, %s, %s, %s, 'https://example.com/mcp/', now() + interval '1 day') RETURNING id""",
            (client, owner, project, agent))[0][0]
        return {"agent": str(agent), "task": str(task), "session": session, "token": token}

    def request(self, project, **changes):
        from mediator.schemas.projects import DeleteProjectRequest
        return DeleteProjectRequest(**{"operationId": uuid4(), "expectedVersion": self.version(project), **changes})

    def tables_containing(self, text):
        """Search the full text of every row in every table."""
        tables = [row[0] for row in self.execute(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")]
        found = {}
        for table in tables:
            count = self.execute(f'SELECT count(*) FROM public."{table}" AS row WHERE row::text ILIKE %s',
                                 (f"%{text}%",))[0][0]
            if count:
                found[table] = count
        return found

    def test_every_trace_of_the_project_is_erased(self):
        from mediator.db.project_deletion import delete_project
        marker = f"ZZ{uuid4().hex}ZZ"
        owner = self.make_user()
        project = self.make_project(owner, marker)
        made = self.fill(owner, project, marker)

        # Prove the scan works and the fixture really reached the important tables.
        before = self.tables_containing(marker)
        for table in ("projects", "tasks", "messages", "contract_approvals", "project_activity", "agents",
                      "plan_proposal_revisions", "project_invitations", "operations", "plan_approvals",
                      "agent_room_exchanges"):
            self.assertIn(table, before)
        for table in ("agent_project_grants", "plan_tasks", "plan_proposals", "mcp_oauth_sessions"):
            self.assertTrue(self.execute(f"SELECT count(*) FROM public.{table} WHERE project_id = %s",
                                         (project,))[0][0], table)

        request = self.request(project)
        result = delete_project(owner, project, request)
        self.assertEqual(result["projectId"], str(project))

        self.assertEqual(self.tables_containing(marker), {})
        self.assertEqual(self.tables_containing(made["task"]), {})
        self.assertEqual(self.tables_containing(made["agent"]), {})
        # Only the delete's own receipt names the project, and it holds no content.
        self.assertEqual(self.tables_containing(str(project)), {"operations": 1})
        receipt = self.execute("SELECT operation_type FROM public.operations WHERE request_payload::text LIKE %s",
                               (f"%{project}%",))
        self.assertEqual(receipt, [("delete_project",)])
        for table in ("mcp_oauth_codes", "mcp_oauth_tokens"):
            self.assertEqual(self.execute(f"SELECT count(*) FROM public.{table} WHERE session_id = %s",
                                          (made["session"],))[0][0], 0)

    def test_other_projects_and_the_owners_account_are_untouched(self):
        from mediator.db.project_deletion import delete_project
        owner = self.make_user()
        doomed = self.make_project(owner, "ZZDOOMEDZZ")
        kept = self.make_project(owner, "ZZKEPTZZ")
        self.fill(owner, doomed, "ZZDOOMEDZZ")
        self.fill(owner, kept, "ZZKEPTZZ")
        before = self.tables_containing("ZZKEPTZZ")

        delete_project(owner, doomed, self.request(doomed))

        self.assertEqual(self.tables_containing("ZZDOOMEDZZ"), {})
        self.assertEqual(self.tables_containing("ZZKEPTZZ"), before)
        self.assertEqual(self.execute("SELECT count(*) FROM public.users WHERE id = %s", (owner,))[0][0], 1)

    def test_another_members_retry_records_are_erased_too(self):
        from mediator.db.messages import create_message
        from mediator.db.project_deletion import delete_project
        from mediator.db.tasks import create_task
        from mediator.schemas.messages import CreateMessageRequest
        from mediator.schemas.tasks import CreateTaskRequest
        owner, friend = self.make_user(), self.make_user("Friend")
        project = self.make_project(owner, "ZZFRIENDZZ")
        self.execute("INSERT INTO public.project_memberships (project_id, user_id, role) VALUES (%s, %s, 'reviewer')",
                     (project, friend))
        task = create_task(owner, project, CreateTaskRequest(
            operationId=uuid4(), expectedVersion=self.version(project), title="ZZFRIENDZZ", description="",
            agentId=None, paths=[], criteria=["Works"], dependencies=[])).entityId
        create_message(friend, project, task, CreateMessageRequest(
            operationId=uuid4(), expectedVersion=self.version(project), body="ZZFRIENDZZ from a friend", replyTo=None))
        delete_project(owner, project, self.request(project))
        self.assertEqual(self.tables_containing("ZZFRIENDZZ"), {})
        self.assertEqual(self.execute("SELECT count(*) FROM public.users WHERE id = %s", (friend,))[0][0], 1)

    def test_purge_script_previews_then_deletes_only_archived_projects(self):
        import importlib.util
        import sys
        from unittest.mock import patch
        path = MIGRATIONS.parents[1] / "scripts" / "purge_archived_projects.py"
        spec = importlib.util.spec_from_file_location("purge_archived_projects", path)
        script = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(script)

        owner = self.make_user()
        archived = self.make_project(owner, "ZZARCHIVEDZZ")
        self.fill(owner, archived, "ZZARCHIVEDZZ")
        active = self.make_project(owner, "ZZACTIVEZZ")
        self.fill(owner, active, "ZZACTIVEZZ")
        self.execute("UPDATE public.projects SET disconnected_at = now() WHERE id = %s", (archived,))
        before = self.tables_containing("ZZARCHIVEDZZ")
        kept = self.tables_containing("ZZACTIVEZZ")

        with patch.object(sys, "argv", ["purge"]), patch("builtins.print"):
            script.main()
        self.assertEqual(self.tables_containing("ZZARCHIVEDZZ"), before)

        with patch.object(sys, "argv", ["purge", "--confirm"]), patch("builtins.print"):
            script.main()
        self.assertEqual(self.tables_containing("ZZARCHIVEDZZ"), {})
        self.assertEqual(self.tables_containing("ZZACTIVEZZ"), kept)

    def test_retry_returns_the_same_result(self):
        from mediator.db.project_deletion import delete_project
        owner = self.make_user()
        project = self.make_project(owner)
        request = self.request(project)
        self.assertEqual(delete_project(owner, project, request), delete_project(owner, project, request))

    def test_only_a_current_owner_with_the_latest_version_can_delete(self):
        from mediator.db.project_deletion import delete_project
        from mediator.db.projects import ProjectAccessDenied, ProjectVersionConflict
        owner, friend, stranger = self.make_user(), self.make_user(), self.make_user()
        project = self.make_project(owner, "ZZGUARDZZ")
        self.execute("INSERT INTO public.project_memberships (project_id, user_id, role) VALUES (%s, %s, 'reviewer')",
                     (project, friend))
        for user in (friend, stranger):
            with self.assertRaises(ProjectAccessDenied):
                delete_project(user, project, self.request(project))
        with self.assertRaises(ProjectVersionConflict):
            delete_project(owner, project, self.request(project, expectedVersion=self.version(project) + 1))
        self.assertIn("projects", self.tables_containing("ZZGUARDZZ"))

    def test_deleted_agents_and_members_lose_access_immediately(self):
        from mediator.db import agent_tasks
        from mediator.db.project_deletion import delete_project
        from mediator.mcp.auth import verify_agent_token
        owner = self.make_user()
        project = self.make_project(owner)
        made = self.fill(owner, project)
        identity = {"agentId": made["agent"], "ownerId": str(owner), "name": "Agent"}
        self.assertIsNotNone(verify_agent_token(made["token"]))
        delete_project(owner, project, self.request(project))
        self.assertIsNone(verify_agent_token(made["token"]))
        with self.assertRaises(agent_tasks.AgentAccessDenied):
            agent_tasks.list_tasks(identity, project)

    def test_repository_can_be_imported_again_after_deletion(self):
        from mediator.db.project_deletion import delete_project
        owner = self.make_user()
        project = self.make_project(owner)
        self.execute("UPDATE public.projects SET github_repository_id = 42, connected_by = %s WHERE id = %s",
                     (owner, project))
        delete_project(owner, project, self.request(project))
        again = self.make_project(owner)
        self.execute("UPDATE public.projects SET github_repository_id = 42, connected_by = %s WHERE id = %s",
                     (owner, again))

    def test_same_name_is_allowed_across_projects_and_users(self):
        owner, friend = self.make_user(), self.make_user("Friend")
        first, second, third = self.make_project(owner), self.make_project(owner), self.make_project(friend)
        agents = {self.register(owner, first), self.register(owner, second), self.register(friend, third)}
        # Each registration is a separate record, so tokens and presence stay per project.
        self.assertEqual(len(agents), 3)

    def test_name_stays_unique_within_a_project(self):
        from mediator.db.agents import AgentNameConflict
        owner, friend = self.make_user(), self.make_user("Friend")
        project = self.make_project(owner)
        self.execute("INSERT INTO public.project_memberships (project_id, user_id, role) VALUES (%s, %s, 'owner')",
                     (project, friend))
        self.register(owner, project)
        for name in ("Claude Code", "claude code", "  Claude Code  "):
            with self.subTest(name=name), self.assertRaises(AgentNameConflict):
                self.register(owner, project, name)
        # Another member's duplicate would be just as ambiguous in the assignment list.
        with self.assertRaises(AgentNameConflict):
            self.register(friend, project)

    def test_a_revoked_agents_name_can_be_reused(self):
        owner = self.make_user()
        project = self.make_project(owner)
        agent = self.register(owner, project)
        self.execute("UPDATE public.agent_project_grants SET status = 'revoked' WHERE agent_id = %s", (agent,))
        self.assertNotEqual(self.register(owner, project), agent)

    def test_conflict_is_clear_if_the_old_index_still_exists(self):
        # Between deploying this code and applying migration 020.
        from mediator.db.agents import AgentNameConflict
        owner = self.make_user()
        self.execute("DELETE FROM public.agents WHERE name = 'Interim'")
        self.register(owner, self.make_project(owner), "Interim")
        self.execute("CREATE UNIQUE INDEX interim_name ON public.agents (name) WHERE name = 'Interim'")
        self.addCleanup(self.execute, "DROP INDEX public.interim_name")
        with self.assertRaises(AgentNameConflict):
            self.register(owner, self.make_project(owner), "Interim")


if __name__ == "__main__":
    unittest.main()
