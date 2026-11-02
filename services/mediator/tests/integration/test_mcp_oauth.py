"""Run only against a NEW disposable database via TANDEM_OAUTH_TEST_DATABASE_URL.

Auth0 identity is stubbed; OAuth HTTP handlers and PostgreSQL transactions are real.
"""
import base64
import hashlib
import os
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

DSN = os.environ.get('TANDEM_OAUTH_TEST_DATABASE_URL')
if DSN:
    os.environ['DATABASE_URL'] = DSN
    os.environ['TANDEM_MCP_OAUTH_ENABLED'] = 'true'
    os.environ['TANDEM_MCP_OAUTH_ISSUER'] = 'http://127.0.0.1:8000'
    os.environ['TANDEM_MCP_OAUTH_DASHBOARD'] = 'http://127.0.0.1:5173'


@unittest.skipUnless(DSN,'Requires a disposable OAuth test database')
class OAuthIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import psycopg
        from fastapi.testclient import TestClient
        from mediator.main import app, get_current_user
        cls.app,cls.dep = app,staticmethod(get_current_user)
        cls.owner,cls.other,cls.project,cls.agent = str(uuid4()),str(uuid4()),str(uuid4()),str(uuid4())
        with psycopg.connect(DSN) as c:
            if c.execute("SELECT to_regclass('public.users')").fetchone()[0]:
                raise RuntimeError('Refusing to run on a database with existing application tables')
            # Minimal real relational foundation needed by migrations 010/011.
            c.execute('''CREATE TABLE public.users(id UUID PRIMARY KEY,name TEXT);
                CREATE TABLE public.projects(id UUID PRIMARY KEY,name TEXT,version BIGINT DEFAULT 1);
                CREATE TABLE public.project_memberships(project_id UUID REFERENCES public.projects,
                    user_id UUID REFERENCES public.users,role TEXT,PRIMARY KEY(project_id,user_id));
                CREATE TABLE public.agents(id TEXT PRIMARY KEY,name TEXT UNIQUE,client TEXT,owner_user_id UUID REFERENCES public.users,
                    grant_status TEXT,token_hash TEXT,owner TEXT,machine TEXT,capabilities TEXT[],presence TEXT,UNIQUE(id,owner_user_id));
                CREATE TABLE public.agent_project_grants(project_id UUID,agent_id TEXT,owner_user_id UUID,
                    status TEXT,granted_by UUID,updated_at TIMESTAMPTZ DEFAULT now(),PRIMARY KEY(project_id,agent_id),
                    FOREIGN KEY(agent_id,owner_user_id) REFERENCES public.agents(id,owner_user_id),
                    FOREIGN KEY(project_id,owner_user_id) REFERENCES public.project_memberships ON DELETE CASCADE);''')
            migration = Path(__file__).resolve().parents[2]/'migrations/versions/011_create_mcp_oauth.sql'
            c.execute(migration.read_text())
            c.execute((migration.parent/'003_create_operations.sql').read_text())
            c.execute('INSERT INTO public.users VALUES (%s,%s),(%s,%s)',(cls.owner,'Owner',cls.other,'Other'))
            c.execute('INSERT INTO public.projects(id,name) VALUES (%s,%s)',(cls.project,'Test project'))
            c.execute("INSERT INTO public.project_memberships VALUES (%s,%s,'owner')",(cls.project,cls.owner))
            c.execute("INSERT INTO public.agents(id,name,client,owner_user_id,grant_status,token_hash) VALUES (%s,'Test agent','Codex',%s,'pending','unissued')",(cls.agent,cls.owner))
            c.execute("INSERT INTO public.agent_project_grants(project_id,agent_id,owner_user_id,status) VALUES (%s,%s,%s,'pending')",(cls.project,cls.agent,cls.owner))
        import logging
        logging.getLogger('httpx').setLevel(logging.WARNING)
        cls.http = TestClient(app,base_url='http://127.0.0.1:8000').__enter__()
        logging.disable(logging.INFO)

    @classmethod
    def tearDownClass(cls):
        cls.http.__exit__(None,None,None)
        cls.app.dependency_overrides.clear()

    def setUp(self):
        import psycopg
        with psycopg.connect(DSN) as c:
            c.execute('TRUNCATE public.mcp_oauth_clients CASCADE')
            c.execute('DELETE FROM public.agent_project_grants WHERE agent_id <> %s',(self.agent,))
            c.execute('DELETE FROM public.agents WHERE id <> %s',(self.agent,))
            c.execute('UPDATE public.projects SET version=1')
            c.execute("UPDATE public.agents SET grant_status='pending'")
            c.execute("UPDATE public.agent_project_grants SET status='pending'")
            c.execute("UPDATE public.project_memberships SET role='owner'")
        self.app.dependency_overrides[self.dep] = lambda: {'id':self.owner,'name':'Owner'}
        self.verifier = 'a'*64
        self.challenge = base64.urlsafe_b64encode(hashlib.sha256(self.verifier.encode()).digest()).decode().rstrip('=')
        self.callback = 'http://127.0.0.1:8456/callback'
        self.resource = 'http://127.0.0.1:8000/mcp/'
        r = self.http.post('/register',json={'client_name':'Test IDE','redirect_uris':[self.callback],
            'token_endpoint_auth_method':'none','grant_types':['authorization_code','refresh_token'],'response_types':['code']})
        self.assertEqual(r.status_code,201,r.text)
        self.client_id = r.json()['client_id']

    def authorize(self, **updates):
        params = {'client_id':self.client_id,'redirect_uri':self.callback,'response_type':'code',
            'code_challenge':self.challenge,'code_challenge_method':'S256','resource':self.resource,'state':'test-state'}
        params.update(updates)
        return self.http.get('/authorize',params=params,follow_redirects=False)

    def code(self):
        r = self.authorize()
        self.assertEqual(r.status_code,302,r.text)
        ticket = r.headers['location'].rsplit('/',1)[-1]
        r = self.http.post('/api/mcp/oauth/preview',json={'ticket':ticket})
        self.assertEqual(r.status_code,200,r.text)
        self.assertEqual(len(r.json()['choices']),1)
        r = self.http.post('/api/mcp/oauth/consent',json={'ticket':ticket,'allow':True,
            'projectId':self.project,'agentId':self.agent})
        self.assertEqual(r.status_code,200,r.text)
        query = parse_qs(urlsplit(r.json()['redirectUrl']).query)
        self.assertEqual(query['state'],['test-state'])
        self.assertEqual(query['iss'],[self.http.get('/.well-known/oauth-authorization-server').json()['issuer']])
        return query['code'][0]

    def exchange(self, code, **updates):
        params = {'client_id':self.client_id,'grant_type':'authorization_code','code':code,
            'code_verifier':self.verifier,'redirect_uri':self.callback,'resource':self.resource}
        params.update(updates)
        return self.http.post('/token',data=params)

    def refresh(self, token):
        return self.http.post('/token',data={'client_id':self.client_id,'grant_type':'refresh_token',
            'refresh_token':token,'resource':self.resource})

    def whoami(self, token):
        return self.http.post('/mcp/',headers={'Authorization':'Bearer '+token,
            'Accept':'application/json, text/event-stream','MCP-Protocol-Version':'2025-03-26'},
            json={'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'tandem_whoami','arguments':{}}})

    def test_complete_flow_and_hashed_storage(self):
        import psycopg
        token = self.exchange(self.code())
        self.assertEqual(token.status_code,200,token.text)
        tokens = token.json()
        result = self.whoami(tokens['access_token'])
        self.assertEqual(result.status_code,200,result.text)
        identity = result.json()['result']['structuredContent']
        self.assertEqual(identity['agentId'],self.agent)
        self.assertEqual([p['projectId'] for p in identity['projects']],[self.project])
        with psycopg.connect(DSN) as c:
            hashes = [r[0] for r in c.execute('SELECT token_hash FROM public.mcp_oauth_tokens')]
        self.assertNotIn(tokens['access_token'],hashes)
        self.assertNotIn(tokens['refresh_token'],hashes)
        self.assertTrue(all(len(h)==64 for h in hashes))

    def test_pkce_redirect_resource_and_replay(self):
        code = self.code()
        for changes in ({'code_verifier':'wrong'},{'redirect_uri':'https://evil.example/callback'},
                        {'resource':'https://other.example/mcp'},{'resource':''}):
            self.assertEqual(self.exchange(code,**changes).status_code,400)
        self.assertEqual(self.exchange(code).status_code,200)
        self.assertEqual(self.exchange(code).status_code,400)

    def test_concurrent_code_exchange_has_one_winner(self):
        code = self.code()
        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses = list(pool.map(lambda _:self.exchange(code).status_code,range(2)))
        self.assertEqual(sorted(statuses),[200,400])

    def test_refresh_rotation_and_reuse_revokes_family(self):
        first = self.exchange(self.code()).json()
        r = self.refresh(first['refresh_token'])
        self.assertEqual(r.status_code,200,r.text)
        second = r.json()
        self.assertNotEqual(first['refresh_token'],second['refresh_token'])
        self.assertEqual(self.refresh(first['refresh_token']).status_code,400)
        self.assertEqual(self.whoami(second['access_token']).status_code,401)
        self.assertEqual(self.refresh(second['refresh_token']).status_code,400)

    def test_create_agent_during_browser_consent(self):
        ticket = self.authorize().headers['location'].rsplit('/',1)[-1]
        preview = self.http.post('/api/mcp/oauth/preview',json={'ticket':ticket}).json()
        operation = str(uuid4())
        body = {'operationId':operation,'expectedVersion':preview['projects'][0]['version'],
                'name':'New IDE agent','client':'Codex','owner':'ignored',
                'machine':'','capabilities':[]}
        url = '/api/projects/'+self.project+'/agents'
        headers = {'Idempotency-Key':operation}
        created = self.http.post(url,json=body,headers=headers)
        self.assertEqual(created.status_code,201,created.text)
        # A retry from the approval page must reuse the same record.
        self.assertEqual(self.http.post(url,json=body,headers=headers).json(),created.json())
        approved = self.http.post('/api/mcp/oauth/consent',json={'ticket':ticket,'allow':True,
            'projectId':self.project,'agentId':created.json()['entityId']})
        self.assertEqual(approved.status_code,200,approved.text)
        code = parse_qs(urlsplit(approved.json()['redirectUrl']).query)['code'][0]
        tokens = self.exchange(code)
        self.assertEqual(tokens.status_code,200,tokens.text)
        self.assertEqual(self.whoami(tokens.json()['access_token']).status_code,200)

    def test_preview_offers_only_owned_projects(self):
        response = self.authorize()
        ticket = response.headers['location'].split('/')[-1]
        preview = self.http.post('/api/mcp/oauth/preview',json={'ticket':ticket}).json()
        self.assertEqual(preview['projects'],[{'id':self.project,'name':'Test project','version':1}])
        import psycopg
        with psycopg.connect(DSN) as c:
            c.execute("UPDATE public.project_memberships SET role='viewer'")
        preview = self.http.post('/api/mcp/oauth/preview',json={'ticket':ticket}).json()
        self.assertEqual(preview['projects'],[])
        self.assertEqual(preview['choices'],[])

    def test_disconnect_and_revoked_project_grant(self):
        import psycopg
        tokens = self.exchange(self.code()).json()
        connections = self.http.get('/api/mcp/oauth/connections').json()
        self.assertEqual(len(connections),1)
        # Onboarding must match the authorized project and agent, not just any session.
        self.assertEqual(connections[0]['agentId'],self.agent)
        self.assertEqual(connections[0]['projectId'],self.project)
        self.assertEqual(self.http.delete('/api/mcp/oauth/connections/'+connections[0]['id']).status_code,204)
        self.assertEqual(self.whoami(tokens['access_token']).status_code,401)
        tokens = self.exchange(self.code()).json()
        with psycopg.connect(DSN) as c:
            c.execute("UPDATE public.agent_project_grants SET status='revoked'")
        self.assertEqual(self.whoami(tokens['access_token']).status_code,401)
        self.assertEqual(self.refresh(tokens['refresh_token']).status_code,400)

    def test_expiry(self):
        import psycopg
        code = self.code()
        with psycopg.connect(DSN) as c:
            c.execute("UPDATE public.mcp_oauth_codes SET expires_at=now()-interval '1 second'")
        self.assertEqual(self.exchange(code).status_code,400)
        tokens = self.exchange(self.code()).json()
        with psycopg.connect(DSN) as c:
            c.execute("UPDATE public.mcp_oauth_tokens SET expires_at=now()-interval '1 second'")
        self.assertEqual(self.whoami(tokens['access_token']).status_code,401)
        self.assertEqual(self.refresh(tokens['refresh_token']).status_code,400)

    def test_consent_cannot_be_stolen_or_replayed(self):
        ticket = self.authorize().headers['location'].rsplit('/',1)[-1]
        self.http.post('/api/mcp/oauth/preview',json={'ticket':ticket})
        self.app.dependency_overrides[self.dep] = lambda: {'id':self.other,'name':'Other'}
        self.assertEqual(self.http.post('/api/mcp/oauth/consent',json={'ticket':ticket,'allow':True,
            'projectId':self.project,'agentId':self.agent}).status_code,409)
        self.app.dependency_overrides[self.dep] = lambda: {'id':self.owner,'name':'Owner'}
        r = self.http.post('/api/mcp/oauth/consent',json={'ticket':ticket,'allow':False})
        self.assertEqual(parse_qs(urlsplit(r.json()['redirectUrl']).query)['error'],['access_denied'])
        self.assertEqual(self.http.post('/api/mcp/oauth/consent',json={'ticket':ticket,'allow':False}).status_code,409)

    def test_unauthorized_human_and_grant(self):
        import psycopg
        ticket = self.authorize().headers['location'].rsplit('/',1)[-1]
        self.app.dependency_overrides.clear()
        self.assertEqual(self.http.post('/api/mcp/oauth/preview',json={'ticket':ticket}).status_code,401)
        self.app.dependency_overrides[self.dep] = lambda: {'id':self.owner,'name':'Owner'}
        self.http.post('/api/mcp/oauth/preview',json={'ticket':ticket})
        with psycopg.connect(DSN) as c:
            c.execute("UPDATE public.project_memberships SET role='reviewer'")
        self.assertEqual(self.http.post('/api/mcp/oauth/consent',json={'ticket':ticket,'allow':True,
            'projectId':self.project,'agentId':self.agent}).status_code,403)

    def test_wrong_client_cannot_exchange_or_revoke(self):
        code = self.code()
        other = self.http.post('/register',json={'redirect_uris':[self.callback],
            'token_endpoint_auth_method':'none','grant_types':['authorization_code','refresh_token']}).json()['client_id']
        self.assertEqual(self.exchange(code,client_id=other).status_code,400)
        tokens = self.exchange(code).json()
        response = self.http.post('/revoke',data={'client_id':other,'token':tokens['access_token']})
        self.assertEqual(response.status_code,200)
        self.assertEqual(self.whoami(tokens['access_token']).status_code,200)

    def test_expired_consent_and_registration_restrictions(self):
        import psycopg
        ticket = self.authorize().headers['location'].rsplit('/',1)[-1]
        with psycopg.connect(DSN) as c:
            c.execute("UPDATE public.mcp_oauth_requests SET expires_at=now()-interval '1 second'")
        self.assertEqual(self.http.post('/api/mcp/oauth/preview',json={'ticket':ticket}).status_code,404)
        for callback in ('http://evil.example/callback','javascript:alert(1)','https://example.com/#fragment'):
            r = self.http.post('/register',json={'redirect_uris':[callback],'token_endpoint_auth_method':'none'})
            self.assertEqual(r.status_code,400)
        self.assertEqual(self.http.post('/register',content='x'*17000).status_code,413)

    def test_discovery_redirect_validation_and_revocation_endpoint(self):
        metadata = self.http.get('/.well-known/oauth-authorization-server').json()
        self.assertEqual(metadata['code_challenge_methods_supported'],['S256'])
        challenge = self.http.post('/mcp/').headers['www-authenticate']
        self.assertIn('/.well-known/oauth-protected-resource/mcp/',challenge)
        self.assertEqual(self.authorize(redirect_uri='https://evil.example/callback').status_code,400)
        tokens = self.exchange(self.code()).json()
        r = self.http.post('/revoke',data={'client_id':self.client_id,'token':tokens['refresh_token']})
        self.assertEqual(r.status_code,200,r.text)
        self.assertEqual(self.whoami(tokens['access_token']).status_code,401)

if __name__=='__main__':
    unittest.main()
