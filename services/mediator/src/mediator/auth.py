# cache the public-key client so we reuse it accross the requests
from functools import lru_cache

import jwt

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

# fetches auth0's public signing keys
from jwt import PyJWKClient

# need different exceptions to distinguish invalid tokens from failures
from jwt.exceptions import (
    InvalidTokenError,
    PyJWKClientConnectionError,
    PyJWKClientError,
)

# backend config
from mediator.config import settings

# Read headers formatted as:
# Authorization: Bearer <access-token>
#
# auto_error=False lets us choose the response when credentials
# are missing, rather than letting HTTPBearer reject them itself.
bearer = HTTPBearer(auto_error=False)

# cache one result: the PyJWKClient objecty
@lru_cache(maxsize=1)
def get_jwks_client() -> PyJWKClient:
    # auth0 publishes its public signing keys at this address
    return PyJWKClient(
        f"https://{settings.auth0_domain}/.well-known/jwks.json",

        # keep a cached copy of auth0 public key set 
        cache_jwk_set=True,

        # refresh an expired key-set cache when its next needed
        # this does not mean a refresh run automatically every 300 seconds 
        # it is done when trying to retrieve the cache the next time if expired
        lifespan = 300,

        # limit the network timeout when fetching public keys 
        timeout = 10,
    )

def require_access_token(
        # fast api first calls bearer to parse the req header
        # supplies the result as this functions credentials argument
        # none means the credentials might be absent
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
) -> dict:
    unauthorized = HTTPException(
        status_code=401,
        detail="Missing or invalid access token",

        # tell the caller this endpoint expects bearer authentication
        headers = {"WWW-Authenticate":"Bearer"},
    )

    # reject requests w/o usable bearer creds
    if credentials is None:
        raise unauthorized

    # extract only the token, excluding the work "Bearer"
    token = credentials.credentials

    try:
        # read signing-key identifier; still untrusted?
        signing_key = get_jwks_client().get_signing_key_from_jwt(token)

        # verify the signature and validate the tokens claims
        # then only should we trust the returned claim
        claims = jwt.decode(
            token,

            # public rsa key selected from auth0's key set 
            signing_key.key,

            algorithms=["RS256"],

            issuer=f"https://{settings.auth0_domain}/",

            # accept tokens intended for our tandem api
            audience = settings.auth0_audience,

            options={"require": ["exp", "iss", "aud", "sub"]},
        )  # Finish token verification before handling any errors.

    except PyJWKClientConnectionError:
        # couldnt fetch auth0s public keys
        raise HTTPException(
            status_code = 503,
            detail="Authentication service unavailable",
        ) from None

    except (InvalidTokenError, PyJWKClientError):
        # Reject invalid signatures, expired tokens, incorrect claims,
        # malformed tokens, or a token whose signing key can't be found.
        raise unauthorized from None

    if not isinstance(claims.get("sub"), str) or not claims["sub"].strip():
        raise unauthorized

    # The caller receives verified token claims as a Python dictionary.
    return claims
