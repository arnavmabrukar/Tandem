"""Profile caching must reduce polling traffic without caching authorization."""
from concurrent.futures import ThreadPoolExecutor
import time
import unittest
from unittest.mock import patch, Mock

import httpx
from fastapi import Depends, FastAPI, HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from fastapi.testclient import TestClient
from jwt.exceptions import ExpiredSignatureError

from mediator import auth


class ProfileCacheTests(unittest.TestCase):
    def setUp(self):
        for _, cache in auth._profile_shards:
            cache.clear()
        self.claims = {'iss': 'https://tenant.test/', 'sub': 'user-1', 'exp': time.time() + 3600}
        self.credentials = HTTPAuthorizationCredentials(scheme='Bearer', credentials='test-token')
        client = patch.object(auth.httpx, 'Client').start()
        self.addCleanup(patch.stopall)
        self.get = client.return_value.__enter__.return_value.get
        self.get.return_value = httpx.Response(200, json={'sub': 'user-1', 'name': 'Test User', 'email': 'test@example.com', 'email_verified': True})

    def profile(self):
        return auth.require_user_profile(self.claims, self.credentials)

    def test_repeated_and_concurrent_requests_share_one_lookup(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: self.profile(), range(20)))
        self.assertEqual(self.get.call_count, 1)
        self.assertTrue(all(result['subject'] == 'user-1' for result in results))
        results[0]['name'] = 'Changed locally'
        self.assertEqual(self.profile()['name'], 'Test User')

    def test_expired_cache_refreshes_and_is_bounded_by_token_expiry(self):
        self.claims['exp'] = time.time() + 10
        with patch.object(auth.time, 'monotonic', return_value=100):
            self.profile()
        with patch.object(auth.time, 'monotonic', return_value=111):
            self.profile()
        self.assertEqual(self.get.call_count, 2)

    def test_profile_ttl_refreshes(self):
        with patch.object(auth.time, 'monotonic', return_value=100):
            self.profile()
        with patch.object(auth.time, 'monotonic', return_value=401):
            self.profile()
        self.assertEqual(self.get.call_count, 2)

    def test_other_tokens_and_subjects_cannot_reuse_profile(self):
        self.profile()
        other = HTTPAuthorizationCredentials(scheme='Bearer', credentials='another-token')
        auth.require_user_profile(self.claims, other)
        with self.assertRaises(HTTPException) as error:
            auth.require_user_profile({**self.claims, 'sub': 'user-2'}, self.credentials)
        self.assertEqual(error.exception.status_code, 502)
        self.assertEqual(self.get.call_count, 3)

    def test_rate_limit_cooldown_and_recovery(self):
        self.get.return_value = httpx.Response(429, headers={'Retry-After': '20'})
        with patch.object(auth.time, 'monotonic', return_value=100):
            for _ in range(3):
                with self.assertRaises(HTTPException) as error:
                    self.profile()
                self.assertEqual(error.exception.status_code, 503)
                self.assertEqual(error.exception.headers['Retry-After'], '20')
        self.assertEqual(self.get.call_count, 1)
        self.get.return_value = httpx.Response(200, json={'sub': 'user-1', 'name': 'Recovered'})
        with patch.object(auth.time, 'monotonic', return_value=121):
            self.assertEqual(self.profile()['name'], 'Recovered')
        self.assertEqual(self.get.call_count, 2)

    def test_failures_and_mismatched_profiles_are_not_cached(self):
        for response, status in [(httpx.Response(401), 401), (httpx.Response(500), 503),
                                 (httpx.Response(200, json={'sub': 'other', 'name': 'Wrong'}), 502)]:
            self.get.return_value = response
            for _ in range(2):
                with self.assertRaises(HTTPException) as error:
                    self.profile()
                self.assertEqual(error.exception.status_code, status)
        self.assertEqual(self.get.call_count, 6)

    def test_cache_is_bounded(self):
        with patch.object(auth, '_PROFILE_SHARD_SIZE', 1):
            for number in range(40):
                token = HTTPAuthorizationCredentials(scheme='Bearer', credentials=f'token-{number}')
                auth.require_user_profile(self.claims, token)
            self.assertLessEqual(sum(len(cache) for _, cache in auth._profile_shards), 16)

    def test_cache_hit_still_requires_valid_jwt(self):
        app = FastAPI()

        @app.get('/profile')
        def profile(value=Depends(auth.require_user_profile)):
            return value

        with patch.object(auth, 'get_jwks_client', return_value=Mock()), \
             patch.object(auth.jwt, 'decode', side_effect=[self.claims, self.claims, ExpiredSignatureError()]) as decode, \
             TestClient(app) as client:
            headers = {'Authorization': 'Bearer test-token'}
            self.assertEqual(client.get('/profile', headers=headers).status_code, 200)
            self.assertEqual(client.get('/profile', headers=headers).status_code, 200)
            self.assertEqual(client.get('/profile', headers=headers).status_code, 401)
        self.assertEqual(decode.call_count, 3)
        self.assertEqual(self.get.call_count, 1)


if __name__ == '__main__':
    unittest.main()
