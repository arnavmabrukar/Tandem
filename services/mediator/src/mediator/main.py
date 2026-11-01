# class used to create web app
# Parse UUIDs and read the Idempotency-Key request header.
from uuid import UUID
from fastapi import Depends, FastAPI, Header, HTTPException

# Rename the imported function to distinguish it from the API handler.
from mediator.db.projects import (
    create_project as save_project,
    OperationConflict,
    ProjectAccessDenied,
)

# Validate incoming requests and outgoing responses.
from mediator.schemas.projects import (
    CreateProjectRequest,
    CreateProjectResponse,
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