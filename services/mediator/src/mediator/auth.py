# cache the public-key client so we reuse it accross the requests
from functools import lru_cache

import jwt

# HTTP client for requesting the signed-in user's Auth0 profile.
import httpx

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

# fetches auth0's public signing keys
from jwt import PyJWKClient

# Validate Auth0's email using the same rules as invitation emails.
from pydantic import EmailStr, TypeAdapter, ValidationError

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



# USER PROFILE
def require_user_profile(
    # Verify the access token before requesting or trusting a profile.
    claims: dict = Depends(require_access_token),

    # Obtain the original bearer token to send to Auth0.
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
) -> dict[str, str]:
    """Return a verified identity and its Auth0 display name."""

    if credentials is None:
        raise HTTPException(
            status_code=401,
            detail="Missing access token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        # Use our configured tenant, never a URL supplied by the caller.
        # Disable redirects so the token stays with this endpoint.
        with httpx.Client(timeout=10.0, follow_redirects=False) as client:
            response = client.get(
                f"https://{settings.auth0_domain}/userinfo",
                headers={
                    "Authorization": f"Bearer {credentials.credentials}",
                    "Accept": "application/json",
                },
            )
    except httpx.RequestError:
        # Network failures are service failures, not invalid credentials.
        raise HTTPException(
            status_code=503,
            detail="Authentication service unavailable",
        ) from None

    if response.status_code == 401:
        raise HTTPException(
            status_code=401,
            detail="Auth0 rejected the access token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if response.status_code != 200:
        # Avoid exposing Auth0's raw response to dashboard users.
        raise HTTPException(
            status_code=503,
            detail="Could not retrieve user profile",
        )

    try:
        profile = response.json()
    except ValueError:
        raise HTTPException(
            status_code=502,
            detail="Invalid user profile response",
        ) from None

    # The profile must belong to the same person as the verified token.
    if not isinstance(profile, dict) or profile.get("sub") != claims["sub"]:
        raise HTTPException(
            status_code=502,
            detail="User profile identity mismatch",
        )

    # Prefer the person's name; use their Auth0 nickname if needed.
    # Do not assume the API access token itself contains profile fields.
    name = profile.get("name")
    if not isinstance(name, str) or not name.strip():
        name = profile.get("nickname")

    if not isinstance(name, str) or not name.strip():
        raise HTTPException(
            status_code=502,
            detail="User profile is missing a display name",
        )

    # Keep the existing identity fields used by /api/me.
    result = {
        "issuer": claims["iss"],
        "subject": claims["sub"],
        "name": name.strip(),
    }

    email = profile.get("email")

    # Only accept the actual boolean True from Auth0.
    # A string such as "false" must never count as verification.
    if profile.get("email_verified") is True and isinstance(email, str):
        try:
            # Match the normalization used by invitation creation.
            verified_email = TypeAdapter(EmailStr).validate_python(
                email.strip().lower()
            )
        except ValidationError:
            # Ordinary sign-in can continue without a usable email.
            # Invitation acceptance will reject the missing verified email.
            pass
        else:
            result["verified_email"] = str(verified_email)

    return result



def require_verified_email(
    # Reuse token verification and the matching Auth0 profile lookup.
    profile: dict[str, str] = Depends(require_user_profile),
) -> dict[str, str]:
    """Require a verified email for recipient invitation actions."""

    # This key is added only when Auth0 explicitly confirms verification.
    if not profile.get("verified_email"):
        raise HTTPException(
            status_code=403,
            detail="Verify your email before accessing invitations",
        )

    # Return both the verified identity and email for the next dependency.
    return profile