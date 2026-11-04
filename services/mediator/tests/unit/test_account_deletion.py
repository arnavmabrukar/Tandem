import unittest
from unittest.mock import MagicMock, patch
from uuid import uuid4

from pydantic import ValidationError
from mediator.db.users import delete_account
from mediator.schemas.users import DeleteAccountRequest


class AccountDeletionTests(unittest.TestCase):
    def run_deletion(self, rows):
        connection = MagicMock()
        connection.__enter__.return_value = connection
        connection.execute.return_value.fetchone.side_effect = rows
        self.connection = connection
        with patch('mediator.db.users._connect', return_value=connection):
            delete_account('issuer', 'subject')
        return [call.args for call in connection.execute.call_args_list]

    def test_sole_owner_blocks_all_mutations(self):
        with self.assertRaisesRegex(ValueError, 'Transfer ownership'):
            self.run_deletion([(uuid4(),), (1,)])
        self.assertTrue(all(call.args[0].lstrip().startswith('SELECT')
                            for call in self.connection.execute.call_args_list))

    def test_deletion_revokes_access_and_detaches_all_identities(self):
        user_id = uuid4()
        calls = self.run_deletion([(user_id,), None])
        writes = [(sql, params) for sql, params in calls if not sql.lstrip().startswith('SELECT')]
        self.assertTrue(all(params == (user_id,) for _, params in writes))
        for table in ('mcp_oauth_sessions', 'mcp_oauth_requests', 'project_memberships',
                      'github_connections', 'github_oauth_states', 'user_identities'):
            self.assertTrue(any(f'DELETE FROM public.{table}' in sql for sql, _ in writes))
        self.assertTrue(any("grant_status = 'revoked'" in sql for sql, _ in writes))
        self.assertTrue(any("auth_issuer = 'deleted'" in sql for sql, _ in writes))
        self.assertFalse(any('DELETE FROM public.projects' in sql for sql, _ in writes))

    def test_retry_without_identity_does_not_modify_data(self):
        self.assertEqual(len(self.run_deletion([None])), 1)

    def test_confirmation_and_identity_spoofing_rejected(self):
        for payload in ({'confirmation': 'delete'}, {'confirmation': 'DELETE', 'userId': str(uuid4())}):
            with self.assertRaises(ValidationError):
                DeleteAccountRequest(**payload)
