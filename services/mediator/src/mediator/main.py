# class used to create web app
# Parse UUIDs and read the Idempotency-Key request header.
from uuid import UUID
from fastapi import Depends, FastAPI, Header, HTTPException

# Add to the existing mediator.auth import.
from mediator.auth import require_verified_email

# Add to the existing mediator.db.invitations import.
from mediator.db.invitations import list_pending_invitations

# Add to the existing mediator.schemas.invitations import.
from mediator.schemas.invitations import PendingInvitationsResponse

# Add to the mediator.db.invitations imports.
from mediator.db.invitations import accept_invitation as accept_saved_invitation

# Add to the mediator.schemas.invitations imports.
from mediator.schemas.invitations import AcceptInvitationRequest

from mediator.db.projects import (
    create_project as save_project,
    update_project as save_project_update,
    OperationConflict,
    ProjectAccessDenied,
    ProjectVersionConflict,
)

from mediator.schemas.projects import (
    CreateProjectRequest,
    CreateProjectResponse,
    UpdateProjectRequest,
    UpdateProjectResponse,
)

from mediator.db.invitations import (
    create_invitation as save_invitation,
    revoke_invitation as cancel_invitation,
    InvitationConflict,
    InvitationNotFound,
)

from mediator.schemas.invitations import (
    CreateInvitationRequest,
    RevokeInvitationRequest,
    InvitationMutationResponse,
)

from fastapi.middleware.cors import CORSMiddleware
from mediator.auth import require_access_token
from psycopg import Error as DatabaseError

# import settings object
from mediator.config import settings
from mediator.db.connection import check_database

# keep token verification for the other protected routes
from mediator.auth import require_access_token, require_user_profile

# Reads the signed-in user's authorized projects from PostgreSQL.
from mediator.db.workspace import load_workspace

# database function that saves or retrieves the Tandem user
from mediator.db.users import get_or_create_user

app = FastAPI(title=settings.app_name)

# permit browser requests form the origins listen in config.py
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,

    # we use bearer tokens rather than cross-site cookies
    allow_credentials=False,

    # HTTP methods used by our dashboard
    allow_methods = ["GET", "POST", "PATCH", "OPTIONS"],

    # headers the frontend may send 
    allow_headers=["Authorization", "Content-Type", "Idempotency-Key"],
)

@app.get("/health")
def health() -> dict[str, str]:
    return {"status":"ok"}


# Liveness (/health) checks the process; readiness also checks PostgreSQL.
# A normal def runs in FastAPI's thread pool so this synchronous database
# call does not block the application's async event loop.
@app.get("/ready")
def ready() -> dict[str, str]:
    try:
        available = check_database()
    except DatabaseError:
        # Never expose database credentials or driver error details to clients.
        available = False
    if not available:
        raise HTTPException(status_code=503, detail="Database unavailable")
    return {"status": "ok", "database": "connected"}

# These routes are placeholders until we implement authentication and storage.
# HTTP 501 explicitly tells the caller that the feature isn't implemented yet.

@app.get("/api/me", dependencies=[Depends(require_access_token)])
def get_current_user(
    # FastAPI resolves this dependency before running the route.
    # It verifies the token and retrieves the matching Auth0 profile.
    profile: dict[str, str] = Depends(require_user_profile),
) -> dict[str, str]:
    try:
        # Create or update the database row, then return its internal ID.
        return get_or_create_user(
            issuer=profile["issuer"],
            subject=profile["subject"],
            name=profile["name"],
        )
    except DatabaseError:
        # Keep database connection details and SQL errors private.
        raise HTTPException(
            status_code=503,
            detail="User database unavailable",
        ) from None

@app.get("/api/workspace", dependencies=[Depends(require_access_token)])
def get_workspace(
    # Verify the token and receive its trusted identity claims.
    # No Auth0 profile request is needed for this database read.
    claims: dict = Depends(require_access_token),
) -> dict:
    try:
        return load_workspace(
            issuer=claims["iss"],
            subject=claims["sub"],
        )
    except DatabaseError:
        # Report database failures without exposing connection details.
        raise HTTPException(
            status_code=503,
            detail="Workspace database unavailable",
        ) from None

@app.post(
    "/api/projects",
    response_model=CreateProjectResponse,
    status_code=201,
)
def create_project(
    # FastAPI validates the incoming JSON against this model.
    request: CreateProjectRequest,

    # Require a UUID in the Idempotency-Key header.
    # Missing or malformed values produce HTTP 422.
    idempotency_key: UUID = Header(alias="Idempotency-Key"),

    # Reuse the existing function to authenticate the caller
    # and resolve their internal Tandem user ID.
    user: dict[str, str] = Depends(get_current_user),
) -> CreateProjectResponse:
    # The header and JSON body must identify the same operation.
    if idempotency_key != request.operationId:
        raise HTTPException(
            status_code=400,
            detail="Idempotency-Key must match operationId",
        )

    try:
        # Ownership comes from authentication, never caller-supplied JSON.
        # The database function commits before returning its result.
        return save_project(
            actor_id=UUID(user["id"]),
            request=request,
        )

    except OperationConflict:
        # The operation ID already belongs to different request data.
        raise HTTPException(
            status_code=409,
            detail="Operation ID was already used for another request",
        ) from None

    except ProjectAccessDenied:
        # A saved operation does not bypass current permissions.
        raise HTTPException(
            status_code=403,
            detail="Project owner access is required",
        ) from None

    except DatabaseError:
        # Avoid exposing SQL errors or database connection details.
        raise HTTPException(
            status_code=503,
            detail="Project database unavailable",
        ) from None

@app.patch(
    "/api/projects/{project_id}",
    response_model=UpdateProjectResponse,
    status_code=200,
)
def update_project(
    # Parse the project ID from the URL and validate its UUID format.
    project_id: UUID,

    # Validate the JSON body, including expectedVersion.
    request: UpdateProjectRequest,

    # Require a valid operation ID in the request header.
    idempotency_key: UUID = Header(alias="Idempotency-Key"),

    # Authenticate the caller and resolve their internal Tandem identity.
    user: dict[str, str] = Depends(get_current_user),
) -> UpdateProjectResponse:
    # The header and body must describe the same operation.
    if idempotency_key != request.operationId:
        raise HTTPException(
            status_code=400,
            detail="Idempotency-Key must match operationId",
        )

    try:
        # The database function checks ownership and version,
        # then commits the edit and saved response together.
        return save_project_update(
            actor_id=UUID(user["id"]),
            project_id=project_id,
            request=request,
        )

    except OperationConflict:
        # This operation ID was previously used with different data.
        raise HTTPException(
            status_code=409,
            detail="Operation ID was already used for another request",
        ) from None

    except ProjectVersionConflict:
        # Another edit has changed the project since it was loaded.
        raise HTTPException(
            status_code=409,
            detail="Project changed; reload before saving",
        ) from None

    except ProjectAccessDenied:
        # Only a current project owner can edit its settings.
        raise HTTPException(
            status_code=403,
            detail="Project owner access is required",
        ) from None

    except DatabaseError:
        # Keep database connection details and SQL errors private.
        raise HTTPException(
            status_code=503,
            detail="Project database unavailable",
        ) from None


# INVITATIONS 

@app.post(
    "/api/projects/{project_id}/invitations",
    response_model=InvitationMutationResponse,
    status_code=201,
)
def create_invitation(
    # Identify the project from the URL.
    project_id: UUID,

    # Validate the email, role, operation ID, and expected version.
    request: CreateInvitationRequest,

    # Require the operation ID in the header too.
    idempotency_key: UUID = Header(alias="Idempotency-Key"),

    # Resolve the authenticated user's internal identity.
    user: dict[str, str] = Depends(get_current_user),
) -> InvitationMutationResponse:
    if idempotency_key != request.operationId:
        raise HTTPException(
            status_code=400,
            detail="Idempotency-Key must match operationId",
        )

    try:
        # The transaction checks that this user currently owns the project.
        return save_invitation(
            actor_id=UUID(user["id"]),
            project_id=project_id,
            request=request,
        )

    except OperationConflict:
        raise HTTPException(
            status_code=409,
            detail="Operation ID was already used for another request",
        ) from None

    except ProjectVersionConflict:
        raise HTTPException(
            status_code=409,
            detail="Project changed; reload before inviting",
        ) from None

    except InvitationConflict:
        # An unexpired pending invitation already exists for this address.
        raise HTTPException(
            status_code=409,
            detail="A pending invitation already exists for this email",
        ) from None

    except ProjectAccessDenied:
        raise HTTPException(
            status_code=403,
            detail="Project owner access is required",
        ) from None

    except DatabaseError:
        # Keep SQL errors and connection details private.
        raise HTTPException(
            status_code=503,
            detail="Invitation database unavailable",
        ) from None


# REVOKE INVITATION
@app.post(
    "/api/projects/{project_id}/invitations/{invitation_id}/revoke",
    response_model=InvitationMutationResponse,
    status_code=200,
)
def revoke_invitation(
    # Validate both IDs from the URL.
    project_id: UUID,
    invitation_id: UUID,

    # Validate the operation ID and expected project version.
    request: RevokeInvitationRequest,

    # Require the matching operation ID in the header.
    idempotency_key: UUID = Header(alias="Idempotency-Key"),

    # Authenticate the caller and resolve their internal user ID.
    user: dict[str, str] = Depends(get_current_user),
) -> InvitationMutationResponse:
    if idempotency_key != request.operationId:
        raise HTTPException(
            status_code=400,
            detail="Idempotency-Key must match operationId",
        )

    try:
        # The database function checks ownership and commits revocation.
        return cancel_invitation(
            actor_id=UUID(user["id"]),
            project_id=project_id,
            invitation_id=invitation_id,
            request=request,
        )

    except OperationConflict:
        raise HTTPException(
            status_code=409,
            detail="Operation ID was already used for another request",
        ) from None

    except ProjectVersionConflict:
        raise HTTPException(
            status_code=409,
            detail="Project changed; reload before revoking",
        ) from None

    except InvitationConflict:
        # Accepted invitations cannot be revoked to remove membership.
        raise HTTPException(
            status_code=409,
            detail="Invitation is no longer pending",
        ) from None

    except InvitationNotFound:
        # Also covers an invitation that belongs to another project.
        raise HTTPException(
            status_code=404,
            detail="Invitation not found",
        ) from None

    except ProjectAccessDenied:
        raise HTTPException(
            status_code=403,
            detail="Project owner access is required",
        ) from None

    except DatabaseError:
        raise HTTPException(
            status_code=503,
            detail="Invitation database unavailable",
        ) from None

@app.get(
    "/api/invitations",
    response_model=PendingInvitationsResponse,
)
def get_pending_invitations(
    # Verify the token, fetch its matching Auth0 profile,
    # and require an explicitly verified email.
    profile: dict[str, str] = Depends(require_verified_email),
) -> PendingInvitationsResponse:
    try:
        result = list_pending_invitations(
            verified_email=profile["verified_email"],
        )

        # Validate the result and serialize UUIDs/timestamps for the browser.
        return PendingInvitationsResponse.model_validate(result)

    except DatabaseError:
        # A database failure must not look like an empty invitation list.
        raise HTTPException(
            status_code=503,
            detail="Invitation database unavailable",
        ) from None


@app.post(
    "/api/invitations/{invitation_id}/accept",
    response_model=InvitationMutationResponse,
    status_code=200,
)
def accept_invitation(
    # Identify the invitation from the URL.
    invitation_id: UUID,

    # The body contains only the operation ID.
    # The caller cannot choose an email, user ID, or role.
    request: AcceptInvitationRequest,

    # Require the same operation ID in the header.
    idempotency_key: UUID = Header(alias="Idempotency-Key"),

    # Verify the token, retrieve the matching Auth0 profile,
    # and require a verified email address.
    profile: dict[str, str] = Depends(require_verified_email),
) -> InvitationMutationResponse:
    if idempotency_key != request.operationId:
        raise HTTPException(
            status_code=400,
            detail="Idempotency-Key must match operationId",
        )

    try:
        # Resolve the internal user from this same verified profile.
        # This also supports someone accepting before visiting /api/me.
        user = get_or_create_user(
            issuer=profile["issuer"],
            subject=profile["subject"],
            name=profile["name"],
        )

        # Identity and recipient email both come from Auth0.
        return accept_saved_invitation(
            actor_id=UUID(user["id"]),
            verified_email=profile["verified_email"],
            invitation_id=invitation_id,
            request=request,
        )

    except OperationConflict:
        raise HTTPException(
            status_code=409,
            detail="Operation ID was already used for another request",
        ) from None

    except InvitationNotFound:
        # Also covers invitations addressed to a different email.
        raise HTTPException(
            status_code=404,
            detail="Invitation not found",
        ) from None

    except InvitationConflict:
        # Covers expired, non-pending invitations and existing membership.
        raise HTTPException(
            status_code=409,
            detail="Invitation cannot be accepted; refresh your invitations",
        ) from None

    except ProjectAccessDenied:
        # A replay cannot restore membership that has been removed.
        raise HTTPException(
            status_code=403,
            detail="Project membership is no longer available",
        ) from None

    except DatabaseError:
        raise HTTPException(
            status_code=503,
            detail="Invitation database unavailable",
        ) from None