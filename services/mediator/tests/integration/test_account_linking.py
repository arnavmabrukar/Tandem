"""Run only against a NEW empty database via TANDEM_ACCOUNTS_TEST_DATABASE_URL.

Covers joining sign-ins that share a verified email, including merging two accounts
that both hold real data, and refusing to join anything on an unverified email.
"""
import hashlib
import os
import secrets
import unittest
from pathlib import Path
from uuid import UUID, uuid4

DSN = os.environ.get("TANDEM_ACCOUNTS_TEST_DATABASE_URL")
if DSN:
    os.environ["DATABASE_URL"] = DSN

MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations" / "versions"
ISSUER = "https://tandem.test/"


@unittest.skipUnless(DSN, "Requires a new empty test database")
class AccountLinkingTests(unittest.TestCase):
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

    def email(self):
        return f"person-{uuid4().hex}@example.com"

    def sign_in(self, subject, email=None, verified=True, name="Eashan Patel"):
        from mediator.db.users import get_or_create_user
        return get_or_create_user(
            issuer=ISSUER, subject=subject, name=name, email=email,
            verified_email=email if verified else None,
        )

    def password(self):
        return f"auth0|{uuid4().hex}"

    def google(self):
        return f"google-oauth2|{uuid4().hex}"

    def user_exists(self, user_id):
        return bool(self.execute("SELECT 1 FROM public.users WHERE id = %s", (user_id,)))

    def project(self, owner, role="owner", github_repository_id=None):
        project = uuid4()
        self.execute(
            """INSERT INTO public.projects (id, name, repository, description, github_repository_id, connected_by)
               VALUES (%s, 'P', 'owner/repo', 'D', %s, %s)""",
            (project, github_repository_id, owner if github_repository_id else None))
        self.execute(
            "INSERT INTO public.project_memberships (project_id, user_id, role) VALUES (%s, %s, %s)",
            (project, owner, role))
        return project

    def version(self, project):
        return self.execute("SELECT version FROM public.projects WHERE id = %s", (project,))[0][0]

    def fill(self, owner, project):
        """Give an account real data, through the same code the product uses."""
        from mediator.db import agent_tasks
        from mediator.db.agents import register_agent
        from mediator.db.approvals import decide_contract
        from mediator.db.invitations import create_invitation
        from mediator.db.messages import create_message
        from mediator.db.plans import approve_plan, create_plan
        from mediator.db.tasks import create_task
        from mediator.schemas.agents import RegisterAgentRequest
        from mediator.schemas.approvals import DecideContractRequest
        from mediator.schemas.invitations import CreateInvitationRequest
        from mediator.schemas.messages import CreateMessageRequest
        from mediator.schemas.plans import ApprovePlanRequest, CreatePlanRequest, PlanProposal
        from mediator.schemas.tasks import CreateTaskRequest

        agent = register_agent(owner, project, RegisterAgentRequest(
            operationId=uuid4(), expectedVersion=self.version(project), name=f"Agent {uuid4().hex[:8]}",
            client="Claude Code", owner="", machine="", capabilities=[])).entityId
        token = "tdm_" + secrets.token_urlsafe(32)
        self.execute("UPDATE public.agents SET grant_status = 'active', token_hash = %s WHERE id = %s",
                     (hashlib.sha256(token.encode()).hexdigest(), agent))
        self.execute("UPDATE public.agent_project_grants SET status = 'active' WHERE agent_id = %s", (agent,))
        identity = {"agentId": str(agent), "ownerId": str(owner), "name": "Agent", "client": "Claude Code",
                    "projects": [{"projectId": str(project), "name": "P", "ownerRole": "owner"}]}

        task = create_task(owner, project, CreateTaskRequest(
            operationId=uuid4(), expectedVersion=self.version(project), title="Task", description="Details",
            agentId=None, paths=[], criteria=["Works"], dependencies=[])).entityId
        create_message(owner, project, task, CreateMessageRequest(
            operationId=uuid4(), expectedVersion=self.version(project), body="Note", replyTo=None))
        approval = self.execute("SELECT id FROM public.contract_approvals WHERE task_id = %s", (task,))[0][0]
        decide_contract(owner, project, approval, DecideContractRequest(
            operationId=uuid4(), expectedVersion=self.version(project), decision="approved", note="Fine",
            target={"action": "Approve contract", "repository": "owner/repo",
                    "taskVersion": 1, "contractVersion": 1, "head": None}))
        agent_tasks.claim_task(identity, project, task, 1, uuid4())

        proposal = PlanProposal(goal="Goal", summary="Summary", tasks=[
            {"key": "one", "title": "Planned", "contractSummary": "Scope", "criteria": ["Works"]}])
        saved = create_plan(owner, project, CreatePlanRequest(
            operationId=uuid4(), expectedVersion=self.version(project), proposal=proposal))
        approve_plan(owner, project, saved.planId, ApprovePlanRequest(
            operationId=uuid4(), expectedVersion=self.version(project), expectedPlanVersion=saved.planVersion,
            note="Plan note", startNow=True))
        create_invitation(owner, project, CreateInvitationRequest(
            operationId=uuid4(), expectedVersion=self.version(project),
            email=f"{uuid4().hex}@example.com", role="reviewer"))

        client = f"client-{uuid4()}"
        self.execute("INSERT INTO public.mcp_oauth_clients (id, metadata) VALUES (%s, '{}')", (client,))
        self.execute(
            """INSERT INTO public.mcp_oauth_sessions (client_id, owner_id, project_id, agent_id, resource, expires_at)
               VALUES (%s, %s, %s, %s, 'https://example.com/mcp/', now() + interval '1 day')""",
            (client, owner, project, agent))
        self.execute(
            """INSERT INTO public.github_connections (user_id, github_user_id, login, token_encrypted)
               VALUES (%s, 1, 'login', 'encrypted') ON CONFLICT DO NOTHING""", (owner,))
        return {"agent": str(agent), "task": task, "token": token}

    def references_to(self, user_id):
        """Scan every table's full text, so a table added later can't be missed."""
        tables = self.execute(
            """SELECT table_name FROM information_schema.tables
               WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'user_merges'""")
        return [
            table for (table,) in tables
            if self.execute(f'SELECT 1 FROM public."{table}" AS t WHERE t::text LIKE %s LIMIT 1', (f"%{user_id}%",))
        ]

    def test_google_after_password_uses_one_account(self):
        email = self.email()
        first = self.sign_in(self.password(), email)
        second = self.sign_in(self.google(), email)
        self.assertEqual(first["id"], second["id"])
        self.assertEqual({row["method"] for row in second["signIns"]}, {"Email and password", "Google"})
        self.assertEqual([row["current"] for row in second["signIns"]], [False, True])

    def test_password_after_google_uses_one_account(self):
        email = self.email()
        self.assertEqual(self.sign_in(self.google(), email)["id"], self.sign_in(self.password(), email)["id"])

    def test_returning_sign_in_keeps_its_account(self):
        email, subject = self.email(), self.google()
        self.assertEqual(self.sign_in(subject, email)["id"], self.sign_in(subject, email)["id"])

    def test_email_case_does_not_matter_once_normalized(self):
        # auth.py lowercases verified emails; the table refuses anything else.
        import psycopg
        with self.assertRaises(psycopg.errors.CheckViolation):
            self.sign_in(self.google(), "Mixed@Example.com")

    def test_unverified_email_cannot_join_someone_elses_account(self):
        email = self.email()
        victim = self.sign_in(self.google(), email)
        attacker = self.sign_in(self.password(), email, verified=False)
        self.assertNotEqual(victim["id"], attacker["id"])
        self.assertFalse(attacker["emailVerified"])
        self.assertEqual(len(attacker["signIns"]), 1)
        self.assertEqual(self.execute(
            "SELECT verified_email FROM public.user_identities WHERE user_id = %s", (attacker["id"],)), [(None,)])

    def test_unverified_first_account_cannot_capture_a_later_verified_one(self):
        email = self.email()
        attacker = self.sign_in(self.password(), email, verified=False)
        person = self.sign_in(self.google(), email)
        self.assertNotEqual(attacker["id"], person["id"])

    def test_losing_verification_stops_future_joins(self):
        email, subject = self.email(), self.password()
        self.sign_in(subject, email)
        self.sign_in(subject, email, verified=False)
        self.assertNotEqual(self.sign_in(subject, email, verified=False)["id"], self.sign_in(self.google(), email)["id"])

    def test_verifying_later_merges_accounts_with_data(self):
        from mediator.db.workspace import load_workspace

        email, password, google = self.email(), self.password(), self.google()
        older = self.sign_in(password, email, verified=False)
        newer = self.sign_in(google, email)
        older_id, newer_id = UUID(older["id"]), UUID(newer["id"])
        older_project = self.project(older_id)
        newer_project = self.project(newer_id)
        moved = self.fill(newer_id, newer_project)
        self.fill(older_id, older_project)

        merged = self.sign_in(password, email)

        self.assertEqual(merged["id"], older["id"])  # The oldest account is kept.
        self.assertFalse(self.user_exists(newer_id))
        self.assertEqual(self.references_to(newer_id), [])
        self.assertEqual(self.execute(
            "SELECT kept_user_id FROM public.user_merges WHERE merged_user_id = %s", (newer_id,)), [(older_id,)])

        # Either sign-in now sees both projects.
        for subject in (password, google):
            seen = {row["id"] for row in load_workspace(issuer=ISSUER, subject=subject)["projects"]}
            self.assertEqual(seen, {str(older_project), str(newer_project)})

        # The moved agent still works under its new owner: every join on owner holds.
        self.assertEqual(self.execute(
            """SELECT a.owner_user_id, g.owner_user_id, m.role FROM public.agents a
               JOIN public.agent_project_grants g ON g.agent_id = a.id
               JOIN public.project_memberships m ON m.project_id = g.project_id AND m.user_id = g.owner_user_id
               WHERE a.id = %s""", (moved["agent"],)), [(older_id, older_id, "owner")])

        from mediator.mcp.auth import verify_agent_token
        identity = verify_agent_token(moved["token"])
        self.assertEqual(identity["ownerId"], older["id"])

    def test_shared_project_keeps_the_higher_role(self):
        email, password, google = self.email(), self.password(), self.google()
        viewer = self.sign_in(password, email, verified=False)
        owner = self.sign_in(google, email)
        project = self.project(UUID(owner["id"]))
        self.execute("INSERT INTO public.project_memberships (project_id, user_id, role) VALUES (%s, %s, 'viewer')",
                     (project, viewer["id"]))
        agent_data = self.fill(UUID(owner["id"]), project)

        kept = self.sign_in(password, email)

        self.assertEqual(self.execute(
            "SELECT user_id::text, role FROM public.project_memberships WHERE project_id = %s", (project,)),
            [(kept["id"], "owner")])
        # Removing the duplicate membership must not have cascaded away the agent's grant.
        self.assertEqual(self.execute(
            "SELECT owner_user_id::text, status FROM public.agent_project_grants WHERE agent_id = %s",
            (agent_data["agent"],)), [(kept["id"], "active")])

    def test_both_accounts_importing_one_repository_keeps_both_projects(self):
        email, password, google = self.email(), self.password(), self.google()
        older = self.sign_in(password, email, verified=False)
        newer = self.sign_in(google, email)
        repository = secrets.randbelow(10**9)
        first = self.project(UUID(older["id"]), github_repository_id=repository)
        second = self.project(UUID(newer["id"]), github_repository_id=repository)

        kept = self.sign_in(password, email)

        self.assertEqual(kept["id"], older["id"])
        self.assertFalse(self.user_exists(newer["id"]))
        rows = dict(self.execute("SELECT id, connected_by::text FROM public.projects WHERE id = ANY(%s)", ([first, second],)))
        self.assertEqual(rows, {first: older["id"], second: None})

    def test_failed_merge_undoes_itself_and_sign_in_still_works(self):
        email, password, google = self.email(), self.password(), self.google()
        older = self.sign_in(password, email, verified=False)
        newer = self.sign_in(google, email)
        project = self.project(UUID(newer["id"]))
        # The membership trigger refuses to change a membership in an archived project.
        self.execute("UPDATE public.projects SET disconnected_at = now() WHERE id = %s", (project,))

        with self.assertLogs("mediator.db.users", level="ERROR"):
            result = self.sign_in(password, email)

        self.assertEqual(result["id"], older["id"])
        self.assertTrue(self.user_exists(newer["id"]))
        with self.assertLogs("mediator.db.users", level="ERROR"):
            self.assertEqual(self.sign_in(google, email)["id"], newer["id"])
        self.assertEqual(self.execute(
            "SELECT user_id::text FROM public.project_memberships WHERE project_id = %s", (project,)), [(newer["id"],)])

    def test_chosen_name_survives_sign_in_and_merge(self):
        from mediator.db.users import update_display_name

        email, password, google = self.email(), self.password(), self.google()
        older = self.sign_in(password, email, verified=False, name="older name")
        newer = self.sign_in(google, email, name="Google Name")
        self.assertEqual(update_display_name(ISSUER, google, "Chosen Name")["name"], "Chosen Name")

        self.assertEqual(self.sign_in(google, email, name="Google Name")["name"], "Chosen Name")
        merged = self.sign_in(password, email, name=email)
        self.assertEqual(merged["id"], older["id"])
        self.assertEqual(merged["name"], "Chosen Name")
        self.assertFalse(self.user_exists(newer["id"]))

    def test_auth0_name_syncs_until_chosen_and_email_never_replaces_a_name(self):
        email, google, password = self.email(), self.google(), self.password()
        self.assertEqual(self.sign_in(google, email, name="First")["name"], "First")
        self.assertEqual(self.sign_in(google, email, name="Second")["name"], "Second")
        self.assertEqual(self.sign_in(password, email, name=email)["name"], "Second")

    def test_email_name_upgrades_to_a_real_name(self):
        email, password, google = self.email(), self.password(), self.google()
        self.assertEqual(self.sign_in(password, email, name=email)["name"], email)
        self.assertEqual(self.sign_in(google, email, name="Real Name")["name"], "Real Name")

    def test_update_for_unknown_sign_in_changes_nothing(self):
        from mediator.db.users import update_display_name
        self.assertIsNone(update_display_name(ISSUER, "auth0|nobody", "Name"))

    def test_user_created_directly_gets_an_identity(self):
        # Earlier code still inserts users directly during a deploy.
        subject = self.google()
        self.execute("INSERT INTO public.users (auth_issuer, auth_subject, name) VALUES (%s, %s, 'Old')", (ISSUER, subject))
        self.assertEqual(self.sign_in(subject)["name"], "Eashan Patel")


if __name__ == "__main__":
    unittest.main()
