"""Persistent OAuth grants. All credentials are random; only SHA-256 hashes persist."""
import hashlib
import secrets
from contextlib import contextmanager

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from mediator.config import settings


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def secret(prefix):
    return prefix + secrets.token_urlsafe(32)


@contextmanager
def database():
    if settings.database_url is None:
        raise RuntimeError('Database is not configured')
    with psycopg.connect(settings.database_url.get_secret_value(), row_factory=dict_row,
                         connect_timeout=10) as conn:
        yield conn


# Authorization is checked live, including after token refresh and membership removal.
IDENTITY_SQL = """
 SELECT s.*, a.name, a.client, p.name AS project_name, m.role
 FROM public.mcp_oauth_sessions s
 JOIN public.agents a ON a.id = s.agent_id AND a.owner_user_id = s.owner_id
 JOIN public.agent_project_grants g ON g.project_id = s.project_id
   AND g.agent_id = s.agent_id AND g.owner_user_id = s.owner_id
 JOIN public.project_memberships m ON m.project_id = s.project_id AND m.user_id = s.owner_id
 JOIN public.projects p ON p.id = s.project_id
 WHERE s.id = %s AND NOT s.revoked AND s.expires_at > now()
   AND a.grant_status = 'active' AND g.status = 'active'
"""


def identity(row):
    return {'agentId': row['agent_id'], 'name': row['name'], 'client': row['client'],
            'ownerId': str(row['owner_id']),
            'projects': [{'projectId': str(row['project_id']), 'name': row['project_name'],
                          'ownerRole': row['role']}]}


class OAuthStore:
    def get_client(self, client_id):
        with database() as c:
            row = c.execute('SELECT metadata FROM public.mcp_oauth_clients WHERE id=%s', (client_id,)).fetchone()
            return row['metadata'] if row else None

    def register_client(self, metadata):
        with database() as c:
            c.execute('INSERT INTO public.mcp_oauth_clients(id, metadata) VALUES (%s,%s)',
                      (metadata['client_id'], Jsonb(metadata)))

    def begin(self, client_id, params):
        ticket = secret('req_')
        with database() as c:
            c.execute('INSERT INTO public.mcp_oauth_requests(ticket_hash,client_id,params) VALUES (%s,%s,%s)',
                      (digest(ticket), client_id, Jsonb(params)))
        return ticket

    def preview(self, ticket, owner_id):
        with database() as c:
            # Bind consent to the authenticated human who first opens it.
            row = c.execute('''UPDATE public.mcp_oauth_requests SET owner_id=%s
                WHERE ticket_hash=%s AND expires_at>now() AND (owner_id IS NULL OR owner_id=%s)
                RETURNING client_id,params''', (owner_id, digest(ticket), owner_id)).fetchone()
            if not row:
                return None
            metadata = c.execute('SELECT metadata FROM public.mcp_oauth_clients WHERE id=%s',
                                 (row['client_id'],)).fetchone()['metadata']
            choices = c.execute('''SELECT g.agent_id AS "agentId", a.name AS "agentName",
                    g.project_id::text AS "projectId", p.name AS "projectName"
                FROM public.agent_project_grants g
                JOIN public.agents a ON a.id=g.agent_id AND a.owner_user_id=g.owner_user_id
                JOIN public.project_memberships m ON m.project_id=g.project_id AND m.user_id=g.owner_user_id
                JOIN public.projects p ON p.id=g.project_id
                WHERE g.owner_user_id=%s AND m.role='owner'
                  AND g.status <> 'revoked' AND a.grant_status <> 'revoked'
                ORDER BY p.name,a.name''', (owner_id,)).fetchall()
            projects = c.execute('''SELECT p.id::text AS id,p.name,p.version
                FROM public.projects p JOIN public.project_memberships m ON m.project_id=p.id
                WHERE m.user_id=%s AND m.role='owner' ORDER BY p.name''', (owner_id,)).fetchall()
            return {'clientName': metadata.get('client_name') or 'Unnamed MCP client',
                    'clientId': row['client_id'], 'redirectUri': row['params']['redirect_uri'],
                    'choices': choices, 'projects': projects}

    def consent(self, ticket, owner_id, project_id, agent_id, allow):
        with database() as c:
            row = c.execute('''DELETE FROM public.mcp_oauth_requests
                WHERE ticket_hash=%s AND owner_id=%s AND expires_at>now() RETURNING *''',
                            (digest(ticket), owner_id)).fetchone()
            if not row:
                return None
            if not allow:
                return {'params': row['params'], 'code': None}
            # Lock membership and grants until consent and session creation commit.
            grant = c.execute('''SELECT g.agent_id FROM public.agent_project_grants g
                JOIN public.agents a ON a.id=g.agent_id AND a.owner_user_id=g.owner_user_id
                JOIN public.project_memberships m ON m.project_id=g.project_id AND m.user_id=g.owner_user_id
                WHERE g.project_id=%s AND g.agent_id=%s AND g.owner_user_id=%s
                  AND m.role='owner' AND a.grant_status <> 'revoked' AND g.status <> 'revoked'
                FOR UPDATE OF g,a FOR SHARE OF m''', (project_id, agent_id, owner_id)).fetchone()
            if not grant:
                raise PermissionError('Choose an agent you own in a project you own')
            c.execute("UPDATE public.agents SET grant_status='active' WHERE id=%s", (agent_id,))
            c.execute("UPDATE public.agent_project_grants SET status='active',updated_at=now() WHERE project_id=%s AND agent_id=%s",
                      (project_id, agent_id))
            session = c.execute('''INSERT INTO public.mcp_oauth_sessions(client_id,owner_id,project_id,agent_id,resource)
                VALUES (%s,%s,%s,%s,%s) RETURNING id''',
                (row['client_id'],owner_id,project_id,agent_id,row['params']['resource'])).fetchone()
            code = secret('code_')
            c.execute('INSERT INTO public.mcp_oauth_codes(code_hash,session_id,params) VALUES (%s,%s,%s)',
                      (digest(code),session['id'],Jsonb(row['params'])))
            return {'params': row['params'], 'code': code}

    def load_code(self, code, client_id):
        with database() as c:
            row = c.execute('''SELECT c.*,s.client_id,s.owner_id FROM public.mcp_oauth_codes c
                JOIN public.mcp_oauth_sessions s ON s.id=c.session_id
                WHERE c.code_hash=%s AND s.client_id=%s AND c.expires_at>now()''',
                            (digest(code),client_id)).fetchone()
            return row

    def _mint(self, c, session_id, refresh=True):
        access = secret('tdoa_')
        c.execute('''INSERT INTO public.mcp_oauth_tokens(token_hash,session_id,kind,expires_at)
            VALUES (%s,%s,'access',now()+interval '1 hour')''', (digest(access),session_id))
        result = {'access_token': access, 'token_type': 'Bearer', 'expires_in': 3600, 'scope': 'tandem:agent'}
        if refresh:
            token = secret('tdor_')
            c.execute('''INSERT INTO public.mcp_oauth_tokens(token_hash,session_id,kind,expires_at)
                SELECT %s,id,'refresh',expires_at FROM public.mcp_oauth_sessions WHERE id=%s''',
                      (digest(token),session_id))
            result['refresh_token'] = token
        return result

    def exchange_code(self, code, client_id, refresh):
        with database() as c:
            # DELETE ... RETURNING consumes the code atomically, including concurrent exchanges.
            row = c.execute('''DELETE FROM public.mcp_oauth_codes WHERE code_hash=%s
                AND expires_at>now() AND session_id IN
                (SELECT id FROM public.mcp_oauth_sessions WHERE client_id=%s) RETURNING session_id''',
                            (digest(code),client_id)).fetchone()
            if not row or not c.execute(IDENTITY_SQL,(row['session_id'],)).fetchone():
                return None
            return self._mint(c,row['session_id'],refresh)

    def load_token(self, token, kind):
        with database() as c:
            row = c.execute('''SELECT * FROM public.mcp_oauth_tokens
                WHERE token_hash=%s AND kind=%s AND expires_at>now()''', (digest(token),kind)).fetchone()
            if not row:
                return None
            session = c.execute(IDENTITY_SQL,(row['session_id'],)).fetchone()
            if not session:
                return None
            # Keep used refresh tokens identifiable so reuse revokes their whole family.
            return {**row, 'session': session}

    def refresh(self, token, client_id):
        with database() as c:
            row = c.execute('''SELECT t.* FROM public.mcp_oauth_tokens t
                JOIN public.mcp_oauth_sessions s ON s.id=t.session_id
                WHERE token_hash=%s AND kind='refresh' AND t.expires_at>now() AND s.client_id=%s
                FOR UPDATE OF t,s''', (digest(token),client_id)).fetchone()
            if not row:
                return None
            if row['used']:
                c.execute('UPDATE public.mcp_oauth_sessions SET revoked=TRUE WHERE id=%s',(row['session_id'],))
                return None  # Commit revocation before the caller returns invalid_grant.
            if not c.execute(IDENTITY_SQL,(row['session_id'],)).fetchone():
                return None
            c.execute('UPDATE public.mcp_oauth_tokens SET used=TRUE WHERE token_hash=%s',(digest(token),))
            return self._mint(c,row['session_id'])

    def revoke(self, token):
        with database() as c:
            c.execute('''UPDATE public.mcp_oauth_sessions SET revoked=TRUE WHERE id IN
                (SELECT session_id FROM public.mcp_oauth_tokens WHERE token_hash=%s)''',(digest(token),))

    def disconnect(self, owner_id, session_id):
        with database() as c:
            c.execute('UPDATE public.mcp_oauth_sessions SET revoked=TRUE WHERE id=%s AND owner_id=%s',
                      (session_id,owner_id))

    def connections(self, owner_id):
        with database() as c:
            return c.execute('''SELECT s.id::text AS id,s.agent_id AS "agentId",s.project_id::text AS "projectId",
                a.name AS "agentName",p.name AS "projectName",
                c.metadata->>'client_name' AS "clientName",s.expires_at AS "expiresAt"
                FROM public.mcp_oauth_sessions s JOIN public.agents a ON a.id=s.agent_id
                JOIN public.projects p ON p.id=s.project_id JOIN public.mcp_oauth_clients c ON c.id=s.client_id
                WHERE s.owner_id=%s AND NOT s.revoked AND s.expires_at>now()
                ORDER BY s.expires_at DESC''',(owner_id,)).fetchall()

store = OAuthStore()
