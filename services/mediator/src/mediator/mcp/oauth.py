"""OAuth protocol adapter. The MCP SDK validates clients, redirects and S256 PKCE."""
import re
import time
from collections import deque
from urllib.parse import urlsplit

from mcp.server.auth.provider import (AuthorizationCode, RefreshToken, AccessToken,
    AuthorizeError, RegistrationError, TokenError, construct_redirect_uri)
from mcp.server.auth.routes import create_auth_routes, create_protected_resource_routes
from mcp.server.auth.settings import ClientRegistrationOptions, RevocationOptions
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken
from pydantic import AnyHttpUrl
from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse
from starlette.requests import Request
from mediator.config import settings
from mediator.mcp.oauth_store import store, identity

SCOPE = 'tandem:agent'


def issuer():
    return settings.mcp_oauth_issuer.rstrip('/')


def resource():
    return issuer() + '/mcp/'


class TandemOAuthProvider:
    async def get_client(self, client_id):
        data = await run_in_threadpool(store.get_client,client_id)
        return OAuthClientInformationFull.model_validate(data) if data else None

    async def register_client(self, client_info):
        # IDE clients are public clients. PKCE supplies proof of possession.
        if client_info.token_endpoint_auth_method != 'none':
            raise RegistrationError('invalid_client_metadata', 'Use token_endpoint_auth_method=none with PKCE')
        if len(client_info.redirect_uris or []) not in range(1,11):
            raise RegistrationError('invalid_redirect_uri','Register between 1 and 10 callback URLs')
        if len(client_info.client_name or '') > 120:
            raise RegistrationError('invalid_client_metadata','Client name is too long')
        for uri in client_info.redirect_uris:
            parsed = urlsplit(str(uri))
            # Native clients use loopback HTTP; remote callbacks must use HTTPS.
            if (parsed.fragment or parsed.username or parsed.password or len(str(uri))>2048
                or not (parsed.scheme=='https' or
                        (parsed.scheme=='http' and parsed.hostname in ('localhost','127.0.0.1','::1')))):
                raise RegistrationError('invalid_redirect_uri','Use HTTPS or an HTTP loopback callback without a fragment')
        if set(client_info.grant_types) - {'authorization_code','refresh_token'}:
            raise RegistrationError('invalid_client_metadata','Unsupported grant type')
        await run_in_threadpool(store.register_client,client_info.model_dump(mode='json'))

    async def authorize(self, client, params):
        if params.state is not None and len(params.state)>2048:
            raise AuthorizeError('invalid_request','State is too long')
        if params.resource != resource():
            raise AuthorizeError('invalid_target','Use the canonical Tandem MCP URL as resource')
        if params.scopes and params.scopes != [SCOPE]:
            raise AuthorizeError('invalid_scope','Only tandem:agent is supported')
        if not re.fullmatch(r'[A-Za-z0-9_-]{43}',params.code_challenge):
            raise AuthorizeError('invalid_request','A valid S256 PKCE challenge is required')
        params.scopes = [SCOPE]
        ticket = await run_in_threadpool(store.begin,client.client_id,params.model_dump(mode='json'))
        # The fragment stays in the browser and out of HTTP access logs/referrers.
        return settings.mcp_oauth_dashboard.rstrip('/') + '/#/mcp/authorize/' + ticket

    async def load_authorization_code(self, client, authorization_code):
        row = await run_in_threadpool(store.load_code,authorization_code,client.client_id)
        if not row:
            return None
        return AuthorizationCode(code=authorization_code,client_id=client.client_id,
            expires_at=row['expires_at'].timestamp(),subject=str(row['owner_id']),
            **{k:v for k,v in row['params'].items() if k != 'state'})

    async def exchange_authorization_code(self, client, authorization_code):
        data = await run_in_threadpool(store.exchange_code,authorization_code.code,client.client_id,
                                      'refresh_token' in client.grant_types)
        if not data:
            raise TokenError('invalid_grant','Code expired, consumed, or access revoked')
        return OAuthToken(**data)

    async def load_refresh_token(self, client, refresh_token):
        row = await run_in_threadpool(store.load_token,refresh_token,'refresh')
        if not row or row['session']['client_id'] != client.client_id:
            return None
        return RefreshToken(token=refresh_token,client_id=client.client_id,scopes=[SCOPE],
            expires_at=int(row['expires_at'].timestamp()),resource=row['session']['resource'],
            subject=str(row['session']['owner_id']))

    async def exchange_refresh_token(self, client, refresh_token, scopes):
        if scopes != [SCOPE]:
            raise TokenError('invalid_scope','Only tandem:agent is supported')
        data = await run_in_threadpool(store.refresh,refresh_token.token,client.client_id)
        if not data:
            raise TokenError('invalid_grant','Refresh token expired, reused, or access revoked')
        return OAuthToken(**data)

    async def load_access_token(self, token):
        if not re.fullmatch(r'tdoa_[A-Za-z0-9_-]{43}',token):
            return None
        row = await run_in_threadpool(store.load_token,token,'access')
        if not row or row['used'] or row['session']['resource'] != resource():
            return None
        s = row['session']
        return AccessToken(token=token,client_id=s['client_id'],scopes=[SCOPE],resource=s['resource'],
            subject=str(s['owner_id']),expires_at=int(row['expires_at'].timestamp()),
            claims={'iss':str(AnyHttpUrl(issuer())),'tandem_identity':identity(s)})

    async def revoke_token(self, token):
        await run_in_threadpool(store.revoke,token.token)


provider = TandemOAuthProvider()


class OAuthEndpointGuard:
    """Enforce resource binding missing from the SDK token handler, and hide DB errors."""
    def __init__(self, app, token_endpoint=False, anonymous=False):
        self.app, self.token_endpoint = app, token_endpoint
        self.anonymous = anonymous
        self.arrivals = deque()


    async def __call__(self, scope, receive, send):
        import psycopg
        # Bound anonymous registration/authorization traffic per worker. Deployments
        # with multiple workers should additionally apply an edge rate limit.
        if self.anonymous and scope['method'] != 'OPTIONS':
            now = time.monotonic()
            while self.arrivals and self.arrivals[0] <= now - 60:
                self.arrivals.popleft()
            if len(self.arrivals) >= 60:
                await JSONResponse({'error':'temporarily_unavailable'},status_code=429,
                    headers={'Retry-After':'60','Cache-Control':'no-store'})(scope,receive,send)
                return
            self.arrivals.append(now)
        if scope['method']=='POST':
            request = Request(scope,receive)
            # Bound the body before parsing or buffering credentials.
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body)>16384:
                    await JSONResponse({'error':'invalid_request'},status_code=413)(scope,receive,send)
                    return
            from urllib.parse import parse_qs
            form = parse_qs(body.decode('utf-8',errors='replace'))
            if self.token_endpoint and (form.get('resource') != [resource()] or any(len(v)!=1 for v in form.values())):
                await JSONResponse({'error':'invalid_target'},status_code=400,
                                   headers={'Cache-Control':'no-store'})(scope,receive,send)
                return
            # Replay the buffered form for the SDK's client/PKCE validation.
            async def replay():
                return {'type':'http.request','body':bytes(body),'more_body':False}
            receive = replay
        try:
            await self.app(scope,receive,send)
        except (psycopg.Error,RuntimeError):
            await JSONResponse({'error':'temporarily_unavailable'},status_code=503,
                               headers={'Cache-Control':'no-store'})(scope,receive,send)


def oauth_routes():
    routes = create_auth_routes(provider,AnyHttpUrl(issuer()),
        client_registration_options=ClientRegistrationOptions(enabled=True,
            valid_scopes=[SCOPE],default_scopes=[SCOPE]),
        revocation_options=RevocationOptions(enabled=True))
    # Correct the SDK's advertised auth methods for our public-client-only policy.
    from starlette.routing import Route
    from mcp.server.auth.routes import build_metadata
    metadata = build_metadata(AnyHttpUrl(issuer()),None,
        ClientRegistrationOptions(enabled=True,valid_scopes=[SCOPE],default_scopes=[SCOPE]),
        RevocationOptions(enabled=True))
    metadata.token_endpoint_auth_methods_supported = ['none']
    metadata.revocation_endpoint_auth_methods_supported = ['none']
    async def discovery(request):
        return JSONResponse(metadata.model_dump(mode='json',exclude_none=True),
                            headers={'Access-Control-Allow-Origin':'*'})
    routes[0] = Route('/.well-known/oauth-authorization-server',discovery)
    # SDK 2.3's revocation form requires a client_secret even for public clients.
    # Authenticate through the SDK, then implement RFC 7009's idempotent response.
    async def revoke(request):
        from mcp.server.auth.middleware.client_auth import ClientAuthenticator, AuthenticationError
        try:
            client = await ClientAuthenticator(provider).authenticate_request(request)
        except AuthenticationError:
            return JSONResponse({'error':'invalid_client'},status_code=401,
                                headers={'Cache-Control':'no-store'})
        form = await request.form()
        raw = form.get('token')
        if not isinstance(raw,str) or not raw:
            return JSONResponse({'error':'invalid_request'},status_code=400)
        token = await provider.load_access_token(raw)
        if token is None:
            token = await provider.load_refresh_token(client,raw)
        if token and token.client_id == client.client_id:
            await provider.revoke_token(token)
        return JSONResponse({},headers={'Cache-Control':'no-store'})
    routes = [Route('/revoke',revoke,methods=['POST']) if r.path=='/revoke' else r for r in routes]
    for route in routes:
        route.app = OAuthEndpointGuard(route.app,route.path=='/token',route.path in ('/register','/authorize'))
    routes.extend(create_protected_resource_routes(AnyHttpUrl(resource()),
        [AnyHttpUrl(issuer())],scopes_supported=[SCOPE],resource_name='Tandem'))
    return routes


def finish_consent(result):
    p = result['params']
    return construct_redirect_uri(p['redirect_uri'],code=result['code'],
        error=None if result['code'] else 'access_denied',state=p.get('state'),
        # Match the SDK metadata's normalized issuer exactly, including its slash.
        iss=str(AnyHttpUrl(issuer())))
