"""Project HTTP/transaction regressions; requires an EMPTY disposable PostgreSQL DB.

Run with TANDEM_PROJECT_TEST_DATABASE_URL set. Only GitHub verification and the
signed-in identity are replaced; routes, validation and PostgreSQL are real.
"""
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import unittest
from unittest.mock import patch
from uuid import uuid4

import psycopg
from fastapi.testclient import TestClient

DSN = os.environ.get('TANDEM_PROJECT_TEST_DATABASE_URL')
if DSN:
    os.environ['DATABASE_URL'] = DSN

from mediator.main import app, get_current_user


@unittest.skipUnless(DSN, 'Requires an empty disposable database')
class ProjectTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with psycopg.connect(DSN) as db:
            if db.execute("SELECT count(*) FROM pg_tables WHERE schemaname='public'").fetchone()[0]:
                raise RuntimeError('Refusing to test on a nonempty database')
            root = Path(__file__).resolve().parents[2] / 'migrations/versions'
            for name in ['001_create_users.sql', '002_create_projects.sql',
                         '003_create_operations.sql', '004_create_project_invitations.sql',
                         '018_github_projects.sql']:
                db.execute((root / name).read_text())

    def setUp(self):
        self.owner = uuid4()
        with psycopg.connect(DSN) as db:
            db.execute("INSERT INTO users(id,auth_issuer,auth_subject,name) VALUES (%s,'test',%s,'Owner')",
                       (self.owner, str(self.owner)))
        previous = app.dependency_overrides.copy()
        self.addCleanup(lambda: setattr(app, 'dependency_overrides', previous))
        app.dependency_overrides[get_current_user] = lambda: {'id': str(self.owner)}
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        verifier = patch('mediator.github.verify_repository', return_value={'name': 'repo', 'full_name': 'owner/repo'})
        verifier.start()
        self.addCleanup(verifier.stop)
        self.body = dict(operationId=str(uuid4()), expectedVersion=None, name='repo',
                         repository='owner/repo', description='Initial', githubRepositoryId=1,
                         githubInstallationId=1, trackedBranch='main')

    def send(self, body=None, project=None, headers=None):
        body = self.body if body is None else body
        headers = {'Idempotency-Key': body['operationId']} if headers is None else headers
        if project:
            return self.client.patch(f'/api/projects/{project}', json=body, headers=headers)
        return self.client.post('/api/projects', json=body, headers=headers)

    def scalar(self, sql, params=()):
        with psycopg.connect(DSN) as db:
            return db.execute(sql, params).fetchone()[0]

    def create(self):
        response = self.send()
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()['projectId']

    def edit(self, **changes):
        return dict(operationId=str(uuid4()), expectedVersion=1, name='repo',
                    repository='owner/repo', description='Edited') | changes

    def test_create_identical_and_concurrent_retries(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda _: self.send(), range(2)))
        for response in responses:
            self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(responses[0].json(), responses[1].json())
        self.assertEqual(self.send().json(), responses[0].json())
        self.assertEqual(self.scalar('SELECT count(*) FROM projects WHERE connected_by=%s', (self.owner,)), 1)
        self.assertEqual(self.scalar('SELECT count(*) FROM project_memberships WHERE user_id=%s AND role=\'owner\'', (self.owner,)), 1)
        self.assertEqual(self.scalar('SELECT count(*) FROM operations WHERE actor_id=%s AND response_payload IS NOT NULL', (self.owner,)), 1)
        self.assertEqual(responses[0].json()['projectVersion'], 1)

    def test_create_conflicting_replay_and_removed_owner(self):
        project = self.create()
        self.assertEqual(self.send(self.body | {'description': 'Changed'}).status_code, 409)
        with psycopg.connect(DSN) as db:
            db.execute('DELETE FROM project_memberships WHERE project_id=%s', (project,))
        self.assertEqual(self.send().status_code, 403)
        self.assertEqual(self.scalar('SELECT count(*) FROM projects WHERE connected_by=%s', (self.owner,)), 1)

    def test_header_and_uuid_validation(self):
        for headers, status in [({}, 422), ({'Idempotency-Key': 'bad'}, 422),
                                ({'Idempotency-Key': str(uuid4())}, 400)]:
            self.assertEqual(self.send(headers=headers).status_code, status)
        self.assertEqual(self.send(self.body | {'operationId': 'bad'}).status_code, 422)
        self.assertEqual(self.scalar('SELECT count(*) FROM operations WHERE actor_id=%s', (self.owner,)), 0)

    def test_create_failure_rolls_back_every_write(self):
        # Fail the last write, after the project and owner membership were inserted.
        with psycopg.connect(DSN) as db:
            db.execute("""CREATE FUNCTION fail_project_audit() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN RAISE EXCEPTION 'Injected failure'; END; $$;
                CREATE TRIGGER fail_project_audit BEFORE UPDATE ON operations
                FOR EACH ROW EXECUTE FUNCTION fail_project_audit();""")
        try:
            self.assertEqual(self.send().status_code, 503)
            self.assertEqual(self.scalar('SELECT count(*) FROM projects WHERE connected_by=%s', (self.owner,)), 0)
            self.assertEqual(self.scalar('SELECT count(*) FROM project_memberships WHERE user_id=%s', (self.owner,)), 0)
            self.assertEqual(self.scalar('SELECT count(*) FROM operations WHERE actor_id=%s', (self.owner,)), 0)
        finally:
            with psycopg.connect(DSN) as db:
                db.execute('DROP TRIGGER fail_project_audit ON operations; DROP FUNCTION fail_project_audit()')
        self.create()  # The very same operation ID is reusable after rollback.

    def test_edit_persistence_replay_and_stale_version(self):
        project = self.create()
        body = self.edit()
        response = self.send(body, project)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), dict(projectId=project, entityId=project, projectVersion=2))
        self.assertEqual(self.scalar('SELECT description FROM projects WHERE id=%s', (project,)), 'Edited')
        self.assertEqual(self.send(body, project).json(), response.json())
        self.assertEqual(self.send(self.edit(), project).status_code, 409)
        self.assertEqual(self.send(body | {'description': 'Conflicting'}, project).status_code, 409)
        self.assertEqual(self.scalar('SELECT version FROM projects WHERE id=%s', (project,)), 2)
        self.assertEqual(self.scalar('SELECT count(*) FROM operations WHERE actor_id=%s AND response_payload IS NULL', (self.owner,)), 0)

    def test_concurrent_edits_only_one_wins(self):
        project = self.create()
        bodies = [self.edit(description='A'), self.edit(description='B')]
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda body: self.send(body, project), bodies))
        self.assertEqual(sorted(r.status_code for r in responses), [200, 409])
        winner = bodies[next(i for i, r in enumerate(responses) if r.status_code == 200)]
        self.assertEqual(self.scalar('SELECT description FROM projects WHERE id=%s', (project,)), winner['description'])
        self.assertEqual(self.scalar('SELECT version FROM projects WHERE id=%s', (project,)), 2)

    def test_concurrent_identical_edits_and_cross_target_replay(self):
        project = self.create()
        body = self.edit()
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda _: self.send(body, project), range(2)))
        self.assertEqual([r.status_code for r in responses], [200, 200])
        self.assertEqual(responses[0].json(), responses[1].json())
        self.assertEqual(self.scalar('SELECT version FROM projects WHERE id=%s', (project,)), 2)
        other = self.send(self.body | {'operationId': str(uuid4()), 'githubRepositoryId': 2}).json()['projectId']
        self.assertEqual(self.send(body, other).status_code, 409)
        self.assertEqual(self.scalar('SELECT version FROM projects WHERE id=%s', (other,)), 1)

    def test_nonowners_cannot_edit_or_replay(self):
        project = self.create()
        body = self.edit()
        self.assertEqual(self.send(body, project).status_code, 200)
        for role in ['viewer', 'reviewer', None]:
            with psycopg.connect(DSN) as db:
                if role:
                    db.execute('UPDATE project_memberships SET role=%s WHERE project_id=%s', (role, project))
                else:
                    db.execute('DELETE FROM project_memberships WHERE project_id=%s', (project,))
            self.assertEqual(self.send(body, project).status_code, 403)
            self.assertEqual(self.send(self.edit(expectedVersion=2), project).status_code, 403)
        self.assertEqual(self.scalar('SELECT version FROM projects WHERE id=%s', (project,)), 2)

    def test_failed_edit_rolls_back_description_version_and_reservation(self):
        project = self.create()
        body = self.edit()
        with patch('mediator.db.projects.UpdateProjectResponse', side_effect=psycopg.OperationalError('Injected')):
            self.assertEqual(self.send(body, project).status_code, 503)
        self.assertEqual(self.scalar('SELECT description FROM projects WHERE id=%s', (project,)), 'Initial')
        self.assertEqual(self.scalar('SELECT version FROM projects WHERE id=%s', (project,)), 1)
        self.assertEqual(self.scalar('SELECT count(*) FROM operations WHERE operation_id=%s', (body['operationId'],)), 0)
        self.assertEqual(self.send(body, project).status_code, 200)

    def test_import_identity_is_immutable(self):
        project = self.create()
        for change in [{'name': 'Renamed'}, {'repository': 'other/repo'}]:
            self.assertEqual(self.send(self.edit(**change), project).status_code, 403)
        self.assertEqual(self.scalar('SELECT version FROM projects WHERE id=%s', (project,)), 1)

    def invitation(self, project, **changes):
        from mediator.db.invitations import create_invitation
        from mediator.schemas.invitations import CreateInvitationRequest
        from uuid import UUID
        request = CreateInvitationRequest(**(dict(operationId=uuid4(), expectedVersion=1,
                                                    email='friend@example.com', role='reviewer') | changes))
        return create_invitation(self.owner, UUID(project), request), request

    def recipient(self):
        user = uuid4()
        with psycopg.connect(DSN) as db:
            db.execute("INSERT INTO users(id,auth_issuer,auth_subject,name) VALUES (%s,'test',%s,'Friend')",
                       (user, str(user)))
        return user

    def test_invitation_accept_concurrent_retry_and_removed_membership(self):
        from mediator.db.invitations import accept_invitation, list_pending_invitations, InvitationNotFound
        from mediator.db.projects import ProjectAccessDenied
        from mediator.schemas.invitations import AcceptInvitationRequest
        project = self.create()
        invite, _ = self.invitation(project)
        recipient = self.recipient()
        request = AcceptInvitationRequest(operationId=uuid4())
        with self.assertRaises(InvitationNotFound):
            accept_invitation(recipient, 'wrong@example.com', invite.entityId, request)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: accept_invitation(recipient, 'friend@example.com', invite.entityId, request), range(2)))
        self.assertEqual(results[0], results[1])
        self.assertEqual(results[0].projectVersion, 3)
        self.assertEqual(self.scalar('SELECT role FROM project_memberships WHERE project_id=%s AND user_id=%s', (project, recipient)), 'reviewer')
        self.assertNotIn(invite.entityId, [i['id'] for i in list_pending_invitations('friend@example.com')['invitations']])
        with psycopg.connect(DSN) as db:
            db.execute('DELETE FROM project_memberships WHERE project_id=%s AND user_id=%s', (project, recipient))
        with self.assertRaises(ProjectAccessDenied):
            accept_invitation(recipient, 'friend@example.com', invite.entityId, request)

    def test_invitation_create_replay_duplicate_and_nonowner(self):
        from mediator.db.invitations import create_invitation, InvitationConflict
        from mediator.db.projects import ProjectAccessDenied, OperationConflict
        from uuid import UUID
        project = self.create()
        invite, request = self.invitation(project)
        self.assertEqual(create_invitation(self.owner, UUID(project), request), invite)
        with self.assertRaises(OperationConflict):
            create_invitation(self.owner, UUID(project), request.model_copy(update={'role': 'viewer'}))
        with self.assertRaises(InvitationConflict):
            self.invitation(project, expectedVersion=2)
        with self.assertRaises(ProjectAccessDenied):
            create_invitation(self.recipient(), UUID(project), request)
        self.assertEqual(self.scalar('SELECT version FROM projects WHERE id=%s', (project,)), 2)
        self.assertEqual(self.scalar('SELECT count(*) FROM operations WHERE actor_id=%s AND response_payload IS NULL', (self.owner,)), 0)

    def test_invitation_accept_revoke_race(self):
        from mediator.db.invitations import accept_invitation, revoke_invitation, InvitationConflict
        from mediator.db.projects import ProjectVersionConflict
        from mediator.schemas.invitations import AcceptInvitationRequest, RevokeInvitationRequest
        from uuid import UUID
        project = self.create()
        invite, _ = self.invitation(project)
        recipient = self.recipient()
        def accept():
            return accept_invitation(recipient, 'friend@example.com', invite.entityId, AcceptInvitationRequest(operationId=uuid4()))
        def revoke():
            return revoke_invitation(self.owner, UUID(project), invite.entityId, RevokeInvitationRequest(operationId=uuid4(), expectedVersion=2))
        def attempt(fn):
            try:
                fn()
                return True
            except (InvitationConflict, ProjectVersionConflict):
                return False
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(attempt, [accept, revoke]))
        self.assertEqual(sum(results), 1)
        self.assertEqual(self.scalar('SELECT count(*) FROM project_memberships WHERE project_id=%s AND user_id=%s', (project, recipient)), int(results[0]))
        self.assertEqual(self.scalar('SELECT version FROM projects WHERE id=%s', (project,)), 3)

    def test_invitation_accept_failure_rolls_back(self):
        from mediator.db.invitations import accept_invitation
        from mediator.schemas.invitations import AcceptInvitationRequest
        project = self.create()
        invite, _ = self.invitation(project)
        recipient = self.recipient()
        request = AcceptInvitationRequest(operationId=uuid4())
        # Fail after membership insertion and version increment, before saving the result.
        with patch('mediator.db.invitations.InvitationMutationResponse', side_effect=psycopg.OperationalError('Injected')):
            with self.assertRaises(psycopg.OperationalError):
                accept_invitation(recipient, 'friend@example.com', invite.entityId, request)
        self.assertEqual(self.scalar('SELECT status FROM project_invitations WHERE id=%s', (invite.entityId,)), 'pending')
        self.assertEqual(self.scalar('SELECT version FROM projects WHERE id=%s', (project,)), 2)
        self.assertEqual(self.scalar('SELECT count(*) FROM project_memberships WHERE user_id=%s', (recipient,)), 0)
        self.assertEqual(self.scalar('SELECT count(*) FROM operations WHERE actor_id=%s', (recipient,)), 0)
        self.assertEqual(accept_invitation(recipient, 'friend@example.com', invite.entityId, request).projectVersion, 3)
