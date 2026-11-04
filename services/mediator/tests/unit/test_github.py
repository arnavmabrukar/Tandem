"""No real GitHub requests or application database are used here."""
import hashlib
import unittest
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

from cryptography.fernet import Fernet
from fastapi import HTTPException
from mediator import github


class GitHubTests(unittest.TestCase):
    @contextmanager
    def database(self, row=None):
        db = MagicMock()
        db.execute.return_value.fetchone.return_value = row
        with patch.object(github, '_transaction') as tx:
            tx.return_value.__enter__.return_value = db
            yield db

    def test_start_binds_hashed_state_to_user_and_uses_pkce(self):
        user = uuid4()
        with self.database() as db, patch.object(github, 'cipher'):
            result = github.start(user)
        params = parse_qs(urlparse(result['url']).query)
        self.assertEqual(params['code_challenge_method'], ['S256'])
        args = db.execute.call_args.args[1]
        self.assertEqual(args[0], hashlib.sha256(params['state'][0].encode()).hexdigest())
        self.assertEqual(args[1], user)
        self.assertNotEqual(args[2], params['code_challenge'][0])

    def test_wrong_or_expired_state_never_exchanges_code(self):
        with self.database(), patch.object(github, 'cipher'), patch.object(github.httpx, 'Client') as client:
            with self.assertRaises(HTTPException) as error:
                github.finish(uuid4(), 'code', 'wrong-state')
            self.assertEqual(error.exception.status_code,400)
            client.assert_not_called()

    def test_tokens_are_decrypted_only_on_backend(self):
        key = Fernet(Fernet.generate_key())
        encrypted = key.encrypt(b'ghu_example').decode()
        with self.database({'token_encrypted':encrypted,'expires_at':None}), patch.object(github,'cipher',return_value=key):
            self.assertEqual(github.user_token(uuid4()),'ghu_example')

    def test_connection_reports_no_link(self):
        with self.database(None), patch.object(github, 'configured', return_value=False):
            self.assertEqual(github.connection(uuid4()), {'connected': False, 'login': None, 'installUrl': None})

    def test_connection_reports_linked_login_without_token(self):
        later = datetime.now(timezone.utc) + timedelta(hours=1)
        with self.database({'login': 'octo', 'expires_at': later}), patch.object(github, 'configured', return_value=True):
            result = github.connection(uuid4())
        self.assertTrue(result['connected'])
        self.assertEqual(result['login'], 'octo')
        self.assertEqual(set(result), {'connected', 'login', 'installUrl'})

    def test_connection_keeps_login_when_link_expired(self):
        earlier = datetime.now(timezone.utc) - timedelta(hours=1)
        with self.database({'login': 'octo', 'expires_at': earlier}), patch.object(github, 'configured', return_value=True):
            result = github.connection(uuid4())
        self.assertFalse(result['connected'])
        self.assertEqual(result['login'], 'octo')

    def test_repository_must_belong_to_selected_installation(self):
        with patch.object(github,'user_token',return_value='secret'), patch.object(github,'api',side_effect=[
            {'name':'repo','full_name':'owner/repo'}, {'repositories':[], 'total_count':0}
        ]) as api:
            with self.assertRaises(HTTPException) as error:
                github.verify_repository(uuid4(),123,456,'main')
            self.assertEqual(error.exception.status_code,403)
            self.assertEqual(api.call_count,2)

    def test_branch_validation_escapes_branch_path(self):
        with patch.object(github,'user_token',return_value='secret'), patch.object(github,'api',side_effect=[
            {'name':'repo','full_name':'owner/repo'}, {'repositories':[{'id':456}], 'total_count':1}, {}
        ]) as api:
            github.verify_repository(uuid4(),123,456,'feature/new')
            api.assert_called_with('secret','/repos/owner/repo/branches/feature%2Fnew')
