from mediator.meta_planner import chat as chat_with_meta
from mediator.schemas.plans import PlanChatRequest, PlanChatResponse
from mediator.meta_planner import generate_plan as generate_meta_plan, PlannerFailed, PlannerUnavailable
from mediator.db.plans import generation_context
from mediator.schemas.plans import GeneratePlanRequest, PlanProposal
import asyncio
from threading import Event
from mediator.db.dispatch import set_auto_delegate, run_dispatcher
from mediator.schemas.assignments import AutoDelegateRequest
from mediator.db.assignments import assign_task as save_assignment
from mediator.schemas.assignments import AssignTaskRequest
from mediator.db import agent_tasks
from mediator.db.task_review import release_task as save_task_release, review_task as save_task_review
from mediator.schemas.task_review import ReleaseTaskRequest, ReviewTaskRequest, TaskDecisionResponse
# class used to create web app
# Parse UUIDs and read the Idempotency-Key request header.
from uuid import UUID
from mediator.db.approvals import decide_contract, ApprovalNotFound, ApprovalConflict
from mediator.schemas.approvals import DecideContractRequest, DecideContractResponse
from mediator.db.agents import register_agent as save_agent, AgentNameConflict
from mediator.schemas.agents import RegisterAgentRequest, RegisterAgentResponse
from fastapi import Depends, FastAPI, Header, HTTPException, Response, Query
from mediator.db.plans import (
    create_plan as save_plan, revise_plan as save_plan_revision,
    get_plan as load_plan, list_plans as load_plans, approve_plan as approve_saved_plan, PlanNotFound, PlanVersionConflict,
)
from mediator.schemas.plans import (
    CreatePlanRequest, RevisePlanRequest, SavePlanResponse, PlanRevisionResponse, ApprovePlanRequest, ApprovePlanResponse,
)
from mediator.db.agents import issue_agent_token, AgentNotFound, AgentTokenConflict
from mediator.schemas.agents import IssueAgentTokenRequest, IssueAgentTokenResponse

# Configure which hostnames may receive MCP requests.
from mcp.server.transport_security import TransportSecuritySettings

# Used to manage startup and shutdown of the MCP server.
from contextlib import asynccontextmanager, contextmanager
from collections.abc import AsyncIterator

# Import the server containing our registered MCP tools.
from mediator.mcp.server import mcp
from mediator.mcp.auth import AgentBearerMiddleware

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

# Database functions perform the transactions.
# Aliases distinguish them from the HTTP route functions below.
from mediator.db.tasks import (
    create_task as save_task,
    cancel_task as cancel_saved_task,
    TaskNotFound,
    TaskStateConflict,
    InvalidTaskDependencies,
)

# Schemas validate request bodies and successful responses.
from mediator.schemas.tasks import (
    CreateTaskRequest,
    CreateTaskResponse,
    CancelTaskRequest,
    CancelTaskResponse,
)

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

# Database function and the error raised for an invalid reply target.
from mediator.db.messages import (
    create_message as save_message,
    InvalidReplyTarget,
)

# Models that validate message requests and successful responses.
from mediator.schemas.messages import (
    CreateMessageRequest,
    CreateMessageResponse,
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
from mediator.db.users import get_or_create_user, update_display_name
from mediator.schemas.users import UpdateProfileRequest





# Build the HTTP application before accessing its session manager.
mcp_http_app = mcp.streamable_http_app(
    streamable_http_path="/",
    stateless_http=True,
    json_response=True,

    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=True,

        # Hostnames only: no https:// prefix or /mcp/ path.
        allowed_hosts=[
            "localhost:*",
            "127.0.0.1:*",
            "tandem-jr3e.onrender.com",
        ],

        # Validate Origin when a client sends that header.
        allowed_origins=[
            "http://localhost:*",
            "http://127.0.0.1:*",
            "https://tandem-jr3e.onrender.com",
        ],
    ),
)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # Start MCP's background resources when FastAPI starts.
    async with mcp.session_manager.run():
        stop = Event()
        worker = (asyncio.create_task(asyncio.to_thread(run_dispatcher, stop))
                  if settings.dispatch_enabled else None)
        try:
            yield
        finally:
            stop.set()
            if worker is not None:
                await worker

    # Leaving the context shuts down MCP's resources cleanly.


# Give FastAPI responsibility for MCP startup and shutdown.
app = FastAPI(
    title=settings.app_name,
    lifespan=lifespan,
)

# Expose the MCP application at /mcp/.
# Existing /api/... routes continue to work.
app.mount("/mcp", AgentBearerMiddleware(mcp_http_app))





# permit browser requests form the origins listen in config.py
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,

    # we use bearer tokens rather than cross-site cookies
    allow_credentials=False,

    # HTTP methods used by our dashboard
    allow_methods = ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],

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
) -> dict:
    try:
        # Create or update the database row, then return its internal ID.
        return get_or_create_user(
            issuer=profile["issuer"],
            subject=profile["subject"],
            name=profile["name"],
            email=profile.get("email"),
            verified_email=profile.get("verified_email"),
        )
    except DatabaseError:
        # Keep database connection details and SQL errors private.
        raise HTTPException(
            status_code=503,
            detail="User database unavailable",
        ) from None

@app.patch("/api/me")
def update_current_user(
    request: UpdateProfileRequest,
    # The person being changed comes from the verified token, never the request.
    claims: dict = Depends(require_access_token),
) -> dict[str, str]:
    try:
        user = update_display_name(
            issuer=claims["iss"],
            subject=claims["sub"],
            name=request.name,
        )
    except DatabaseError:
        raise HTTPException(
            status_code=503,
            detail="User database unavailable",
        ) from None
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    return user

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

    except OperationConflict as error:
        # The operation ID already belongs to different request data.
        raise HTTPException(
            status_code=409,
            detail=str(error),
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


# Register a pending agent; credential issuance is a separate operation.
@app.post(
    "/api/projects/{project_id}/agents",
    response_model=RegisterAgentResponse,
    status_code=201,
)
def register_agent(
    project_id: UUID,
    request: RegisterAgentRequest,
    idempotency_key: UUID = Header(alias="Idempotency-Key"),
    user: dict[str, str] = Depends(get_current_user),
) -> RegisterAgentResponse:
    # Reject inconsistent retry identifiers before performing database writes.
    if idempotency_key != request.operationId:
        raise HTTPException(status_code=400, detail="Idempotency-Key must match operationId")

    try:
        # Ownership comes from authentication, never the submitted owner label.
        # The transaction also checks current project-owner permission.
        return save_agent(
            actor_id=UUID(user["id"]),
            project_id=project_id,
            request=request,
        )
    except ProjectAccessDenied:
        raise HTTPException(status_code=403, detail="Project owner access is required") from None
    except (OperationConflict, ProjectVersionConflict, AgentNameConflict) as error:
        # These exceptions contain controlled public messages, not SQL details.
        raise HTTPException(status_code=409, detail=str(error)) from None
    except DatabaseError:
        raise HTTPException(status_code=503, detail="Agent database unavailable") from None


@app.post(
    "/api/projects/{project_id}/agents/{agent_id}/token",
    response_model=IssueAgentTokenResponse,
)
def issue_registered_agent_token(
    project_id: UUID,
    agent_id: str,
    request: IssueAgentTokenRequest,
    response: Response,
    idempotency_key: UUID = Header(alias="Idempotency-Key"),
    user: dict[str, str] = Depends(get_current_user),
) -> IssueAgentTokenResponse:
    # Credential responses must not be cached by browsers or intermediaries.
    response.headers["Cache-Control"] = "no-store"
    if idempotency_key != request.operationId:
        raise HTTPException(status_code=400, detail="Idempotency-Key must match operationId")
    try:
        return issue_agent_token(UUID(user["id"]), project_id, agent_id, request)
    except ProjectAccessDenied:
        raise HTTPException(status_code=403, detail="Project owner access is required") from None
    except AgentNotFound:
        raise HTTPException(status_code=404, detail="Agent not found") from None
    except (OperationConflict, ProjectVersionConflict, AgentTokenConflict) as error:
        raise HTTPException(status_code=409, detail=str(error)) from None
    except DatabaseError:
        raise HTTPException(status_code=503, detail="Agent database unavailable") from None


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
            email=profile.get("email"),
            verified_email=profile["verified_email"],
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


@contextmanager
def plan_api_errors():
    """Translate storage failures without exposing SQL or credentials."""
    try:
        yield
    except ProjectAccessDenied:
        raise HTTPException(403, "Insufficient project access for this action") from None
    except PlanNotFound:
        raise HTTPException(404, "Plan revision not found in this project") from None
    except OperationConflict:
        raise HTTPException(409, "Operation ID was already used for another request") from None
    except ProjectVersionConflict:
        raise HTTPException(409, "Project changed; reload before saving") from None
    except PlanVersionConflict:
        raise HTTPException(409, "Plan changed; reload before saving") from None
    except DatabaseError:
        raise HTTPException(503, "Plan database unavailable") from None


# A preview never creates tasks, approvals, or operations.


@app.post("/api/projects/{project_id}/plans/chat", response_model=PlanChatResponse)
def plan_chat(project_id: UUID, request: PlanChatRequest,
              user: dict[str, str] = Depends(get_current_user)):
    with plan_api_errors():
        context = generation_context(UUID(user["id"]), project_id)
        try:
            result = chat_with_meta(request, context)
        except PlannerUnavailable:
            raise HTTPException(503, "Meta planning is not configured") from None
        except PlannerFailed:
            raise HTTPException(502, "Meta could not reply; please try again") from None
        # Recheck access after waiting for the external model.
        generation_context(UUID(user["id"]), project_id)
        return result


@app.post("/api/projects/{project_id}/plans/generate", response_model=PlanProposal)
def generate_plan_preview(project_id: UUID, request: GeneratePlanRequest,
                          user: dict[str, str] = Depends(get_current_user)):
    with plan_api_errors():
        context = generation_context(UUID(user["id"]), project_id)
        try:
            proposal = generate_meta_plan(request.goal, context)
        except PlannerUnavailable:
            raise HTTPException(503, "Meta planning is not configured") from None
        except PlannerFailed:
            raise HTTPException(502, "Meta could not generate a valid plan") from None
        # Membership may have changed during the external call.
        generation_context(UUID(user["id"]), project_id)
        return proposal


@app.post("/api/projects/{project_id}/plans", response_model=SavePlanResponse, status_code=201)
def create_plan(
    project_id: UUID,
    request: CreatePlanRequest,
    idempotency_key: UUID = Header(alias="Idempotency-Key"),
    user: dict[str, str] = Depends(get_current_user),
) -> SavePlanResponse:
    # Owners can save drafts. This does not approve or start agent work.
    if idempotency_key != request.operationId:
        raise HTTPException(400, "Idempotency-Key must match operationId")
    with plan_api_errors():
        return save_plan(actor_id=UUID(user["id"]), project_id=project_id, request=request)


@app.get("/api/projects/{project_id}/plans", response_model=list[PlanRevisionResponse])
def list_plans(project_id: UUID, user: dict[str, str] = Depends(get_current_user)):
    with plan_api_errors():
        return load_plans(actor_id=UUID(user["id"]), project_id=project_id)


@app.post("/api/projects/{project_id}/plans/{plan_id}/approve", response_model=ApprovePlanResponse)
def approve_plan(project_id: UUID, plan_id: UUID, request: ApprovePlanRequest,
                 idempotency_key: UUID = Header(alias="Idempotency-Key"),
                 user: dict[str, str] = Depends(get_current_user)):
    if idempotency_key != request.operationId:
        raise HTTPException(400, "Idempotency-Key must match operationId")
    if request.startNow and not settings.dispatch_enabled:
        raise HTTPException(503, "Automatic delegation is disabled on this backend")
    with plan_api_errors():
        return approve_saved_plan(actor_id=UUID(user["id"]), project_id=project_id,
                                  plan_id=plan_id, request=request)


@app.post("/api/projects/{project_id}/plans/{plan_id}/revisions",
          response_model=SavePlanResponse, status_code=201)
def revise_plan(
    project_id: UUID,
    plan_id: UUID,
    request: RevisePlanRequest,
    idempotency_key: UUID = Header(alias="Idempotency-Key"),
    user: dict[str, str] = Depends(get_current_user),
) -> SavePlanResponse:
    # Both project and plan versions are checked inside the transaction.
    if idempotency_key != request.operationId:
        raise HTTPException(400, "Idempotency-Key must match operationId")
    with plan_api_errors():
        return save_plan_revision(actor_id=UUID(user["id"]), project_id=project_id,
                                  plan_id=plan_id, request=request)


@app.get("/api/projects/{project_id}/plans/{plan_id}", response_model=PlanRevisionResponse)
def get_plan(
    project_id: UUID,
    plan_id: UUID,
    version: int | None = Query(default=None, ge=1),
    user: dict[str, str] = Depends(get_current_user),
) -> PlanRevisionResponse:
    # Members can read. Omit version for latest; use ?version=1 for history.
    with plan_api_errors():
        return load_plan(actor_id=UUID(user["id"]), project_id=project_id,
                         plan_id=plan_id, version=version)


# TASK CREATION
@app.post(
    "/api/projects/{project_id}/tasks",
    response_model=CreateTaskResponse,
    status_code=201,
)
def create_task(
    # Read the project ID from the URL.
    # FastAPI rejects values that are not valid UUIDs.
    project_id: UUID,

    # Validate the submitted JSON using our task request schema.
    request: CreateTaskRequest,

    # Require the operation ID in the HTTP header.
    idempotency_key: UUID = Header(alias="Idempotency-Key"),

    # Authenticate the caller and retrieve their Tandem user record.
    # This dependency calls the Python function, not the /api/me URL.
    user: dict[str, str] = Depends(get_current_user),
) -> CreateTaskResponse:
    # The header and body must identify the same operation.
    if idempotency_key != request.operationId:
        raise HTTPException(
            status_code=400,
            detail="Idempotency-Key must match operationId",
        )

    try:
        # The database function checks project permissions,
        # handles retries, and commits the task before returning.
        return save_task(
            actor_id=UUID(user["id"]),
            project_id=project_id,
            request=request,
        )

    except InvalidTaskDependencies:
        # Do not reveal whether an inaccessible prerequisite exists elsewhere.
        raise HTTPException(
            status_code=422,
            detail="Every dependency must be a task in this project",
        ) from None

    except OperationConflict:
        # The caller reused an operation ID with different request data.
        raise HTTPException(
            status_code=409,
            detail="Operation ID was already used for another request",
        ) from None

    except ProjectVersionConflict:
        # The project changed since the dashboard last loaded it.
        raise HTTPException(
            status_code=409,
            detail="Project changed; reload before creating the task",
        ) from None

    except ProjectAccessDenied:
        # Only current owners and reviewers may create tasks.
        raise HTTPException(
            status_code=403,
            detail="Project owner or reviewer access is required",
        ) from None

    except DatabaseError:
        # Keep SQL errors and connection details out of the response.
        raise HTTPException(
            status_code=503,
            detail="Task database unavailable",
        ) from None

@contextmanager
def task_decision_errors():
    try:
        yield
    except ProjectAccessDenied:
        raise HTTPException(403, "Project owner or reviewer access is required") from None
    except agent_tasks.AgentTaskNotFound:
        raise HTTPException(404, "Task not found in this project") from None
    except OperationConflict:
        raise HTTPException(409, "Operation ID was already used for another request") from None
    except ProjectVersionConflict:
        raise HTTPException(409, "Project changed; reload before deciding") from None
    except agent_tasks.AgentTaskConflict as error:
        raise HTTPException(409, str(error)) from None
    except (DatabaseError, RuntimeError):
        raise HTTPException(503, "Task database unavailable") from None


@app.post("/api/projects/{project_id}/tasks/{task_id}/review", response_model=TaskDecisionResponse)
def review_task(project_id: UUID, task_id: UUID, request: ReviewTaskRequest,
                idempotency_key: UUID = Header(alias="Idempotency-Key"),
                user: dict[str, str] = Depends(get_current_user)):
    # Accepting is what unlocks tasks that depend on this one.
    if idempotency_key != request.operationId:
        raise HTTPException(400, "Idempotency-Key must match operationId")
    with task_decision_errors():
        return save_task_review(UUID(user["id"]), project_id, task_id, request)


@app.post("/api/projects/{project_id}/tasks/{task_id}/release", response_model=TaskDecisionResponse)
def release_task(project_id: UUID, task_id: UUID, request: ReleaseTaskRequest,
                 idempotency_key: UUID = Header(alias="Idempotency-Key"),
                 user: dict[str, str] = Depends(get_current_user)):
    if idempotency_key != request.operationId:
        raise HTTPException(400, "Idempotency-Key must match operationId")
    with task_decision_errors():
        return save_task_release(UUID(user["id"]), project_id, task_id, request)


@app.post("/api/projects/{project_id}/auto-delegate")
def configure_auto_delegate(project_id: UUID, request: AutoDelegateRequest,
                            idempotency_key: UUID = Header(alias="Idempotency-Key"),
                            user: dict[str, str] = Depends(get_current_user)) -> dict:
    if idempotency_key != request.operationId:
        raise HTTPException(400, "Idempotency-Key must match operationId")
    if request.enabled and not settings.dispatch_enabled:
        raise HTTPException(503, "Automatic delegation is disabled on this backend")
    try:
        return set_auto_delegate(UUID(user["id"]), project_id, request)
    except ProjectAccessDenied as error:
        raise HTTPException(403, str(error)) from None
    except (OperationConflict, ProjectVersionConflict) as error:
        raise HTTPException(409, str(error)) from None
    except (DatabaseError, RuntimeError):
        raise HTTPException(503, "Delegation settings unavailable") from None


@app.post("/api/projects/{project_id}/tasks/{task_id}/assignment")
def assign_task(project_id: UUID, task_id: UUID, request: AssignTaskRequest,
                idempotency_key: UUID = Header(alias="Idempotency-Key"),
                user: dict[str, str] = Depends(get_current_user)) -> dict:
    if idempotency_key != request.operationId:
        raise HTTPException(400, "Idempotency-Key must match operationId")
    try:
        return save_assignment(UUID(user["id"]), project_id, task_id, request)
    except (ProjectAccessDenied, agent_tasks.AgentAccessDenied) as error:
        raise HTTPException(403, str(error)) from None
    except agent_tasks.AgentTaskNotFound:
        raise HTTPException(404, "Task not found in this project") from None
    except (OperationConflict, ProjectVersionConflict, agent_tasks.AgentTaskConflict,
            agent_tasks.AgentClaimBlocked) as error:
        raise HTTPException(409, str(error)) from None
    except (DatabaseError, RuntimeError):
        raise HTTPException(503, "Task assignment unavailable") from None


# CANCEL TASK
@app.post(
    "/api/projects/{project_id}/tasks/{task_id}/cancel",
    response_model=CancelTaskResponse,
    status_code=200,
)
def cancel_task(
    # Parse the project and task IDs from the URL.
    project_id: UUID,
    task_id: UUID,

    # Validate operationId and expectedVersion from the JSON body.
    request: CancelTaskRequest,

    # Require an operation ID in the request header.
    idempotency_key: UUID = Header(alias="Idempotency-Key"),

    # Resolve the authenticated user's internal Tandem identity.
    user: dict[str, str] = Depends(get_current_user),
) -> CancelTaskResponse:
    # Header and body must identify the same operation.
    if idempotency_key != request.operationId:
        raise HTTPException(
            status_code=400,
            detail="Idempotency-Key must match operationId",
        )

    try:
        # The database function checks permissions, task state,
        # project version, and retries before committing.
        return cancel_saved_task(
            actor_id=UUID(user["id"]),
            project_id=project_id,
            task_id=task_id,
            request=request,
        )

    except OperationConflict:
        # An operation ID cannot represent two different requests.
        raise HTTPException(
            status_code=409,
            detail="Operation ID was already used for another request",
        ) from None

    except ProjectVersionConflict:
        # The dashboard must reload the changed project before retrying
        # with a new operation.
        raise HTTPException(
            status_code=409,
            detail="Project changed; reload before cancelling the task",
        ) from None

    except ProjectAccessDenied:
        # Only current project owners and reviewers can cancel tasks.
        raise HTTPException(
            status_code=403,
            detail="Project owner or reviewer access is required",
        ) from None

    except TaskNotFound:
        # This also covers a task belonging to another project.
        raise HTTPException(
            status_code=404,
            detail="Task not found in this project",
        ) from None

    except TaskStateConflict:
        # Active-agent cancellation is not implemented yet.
        raise HTTPException(
            status_code=409,
            detail="Only open tasks can currently be cancelled",
        ) from None

    except DatabaseError:
        # Keep database details private.
        raise HTTPException(
            status_code=503,
            detail="Task database unavailable",
        ) from None


@app.post(
    "/api/projects/{project_id}/tasks/{task_id}/messages",
    response_model=CreateMessageResponse,
    status_code=201,
)
def create_message(
    # Validate the project and task IDs from the URL.
    project_id: UUID,
    task_id: UUID,

    # Validate the message body, reply target, and operation metadata.
    request: CreateMessageRequest,

    # Require the same operation ID in the header and request body.
    idempotency_key: UUID = Header(alias="Idempotency-Key"),

    # Authenticate the caller and retrieve their internal Tandem identity.
    user: dict[str, str] = Depends(get_current_user),
) -> CreateMessageResponse:
    if idempotency_key != request.operationId:
        raise HTTPException(
            status_code=400,
            detail="Idempotency-Key must match operationId",
        )

    try:
        # Identity comes from authentication.
        # The database function commits before returning its response.
        return save_message(
            actor_id=UUID(user["id"]),
            project_id=project_id,
            task_id=task_id,
            request=request,
        )

    except OperationConflict:
        # An operation ID cannot be reused with different request data.
        raise HTTPException(
            status_code=409,
            detail="Operation ID was already used for another request",
        ) from None

    except ProjectVersionConflict:
        # Another action changed the project after the dashboard loaded it.
        raise HTTPException(
            status_code=409,
            detail="Project changed; reload before posting the message",
        ) from None

    except ProjectAccessDenied:
        # Viewers and nonmembers cannot post notes.
        raise HTTPException(
            status_code=403,
            detail="Project owner or reviewer access is required",
        ) from None

    except TaskNotFound:
        # Do not reveal whether the task exists in another project.
        raise HTTPException(
            status_code=404,
            detail="Task not found in this project",
        ) from None

    except InvalidReplyTarget:
        # Reject missing reply targets and targets from another thread.
        raise HTTPException(
            status_code=422,
            detail="Reply target must belong to this task",
        ) from None

    except DatabaseError:
        # Keep database credentials and SQL details private.
        raise HTTPException(
            status_code=503,
            detail="Message database unavailable",
        ) from None


@app.post(
    "/api/projects/{project_id}/approvals/{approval_id}/decisions",
    response_model=DecideContractResponse,
)
def record_contract_decision(
    project_id: UUID,
    approval_id: UUID,
    request: DecideContractRequest,
    idempotency_key: UUID = Header(alias="Idempotency-Key"),
    user: dict[str, str] = Depends(get_current_user),
) -> DecideContractResponse:
    # Require consistent retry identifiers; identity comes from authentication.
    if idempotency_key != request.operationId:
        raise HTTPException(status_code=400, detail="Idempotency-Key must match operationId")
    try:
        return decide_contract(UUID(user["id"]), project_id, approval_id, request)
    except ProjectAccessDenied:
        raise HTTPException(status_code=403, detail="Project owner or reviewer access is required") from None
    except ApprovalNotFound:
        raise HTTPException(status_code=404, detail="Approval not found in this project") from None
    except (OperationConflict, ProjectVersionConflict, ApprovalConflict) as error:
        # These domain errors contain only controlled, public explanations.
        raise HTTPException(status_code=409, detail=str(error)) from None
    except DatabaseError:
        raise HTTPException(status_code=503, detail="Approval database unavailable") from None


# OAuth uses the same Auth0-authenticated human as the existing dashboard.
# No client-supplied owner ID or Auth0 credential is forwarded to an MCP client.
if settings.mcp_oauth_enabled:
    from mediator.mcp.oauth import oauth_routes, finish_consent
    from mediator.mcp.oauth_store import store as oauth_store
    from pydantic import BaseModel, ConfigDict, Field

    app.router.routes.extend(oauth_routes())

    class OAuthConsentRequest(BaseModel):
        model_config = ConfigDict(extra="forbid")
        ticket: str = Field(pattern=r"^req_[A-Za-z0-9_-]{43}$")
        allow: bool = False
        projectId: UUID | None = None
        agentId: str | None = Field(default=None, max_length=200)

    class OAuthPreviewRequest(BaseModel):
        ticket: str = Field(pattern=r"^req_[A-Za-z0-9_-]{43}$")

    @app.post("/api/mcp/oauth/preview")
    def preview_oauth(body: OAuthPreviewRequest, response: Response,
                      user: dict = Depends(get_current_user)):
        response.headers["Cache-Control"] = "no-store"
        try:
            result = oauth_store.preview(body.ticket,user["id"])
        except DatabaseError:
            raise HTTPException(503,"OAuth storage unavailable") from None
        if not result:
            raise HTTPException(404,"Authorization request expired or already completed. Reconnect from your IDE.")
        return result

    @app.post("/api/mcp/oauth/consent")
    def consent_oauth(body: OAuthConsentRequest, response: Response,
                      user: dict = Depends(get_current_user)):
        response.headers["Cache-Control"] = "no-store"
        if body.allow and (body.projectId is None or not body.agentId):
            raise HTTPException(400,"Choose an agent and project")
        try:
            result = oauth_store.consent(body.ticket,user["id"],body.projectId,body.agentId,body.allow)
        except PermissionError:
            raise HTTPException(403,"You must own the selected agent and project") from None
        except DatabaseError:
            raise HTTPException(503,"OAuth storage unavailable") from None
        if not result:
            raise HTTPException(409,"Authorization request expired or already completed. Reconnect from your IDE.")
        return {"redirectUrl":finish_consent(result)}

    @app.get("/api/mcp/oauth/connections")
    def oauth_connections(response: Response, user: dict = Depends(get_current_user)):
        response.headers["Cache-Control"] = "no-store"
        try:
            return oauth_store.connections(user["id"])
        except DatabaseError:
            raise HTTPException(503,"OAuth storage unavailable") from None

    @app.delete("/api/mcp/oauth/connections/{session_id}", status_code=204)
    def disconnect_oauth(session_id: UUID, user: dict = Depends(get_current_user)):
        try:
            oauth_store.disconnect(user["id"],session_id)
        except DatabaseError:
            raise HTTPException(503,"OAuth storage unavailable") from None

# GitHub integration uses the human's authenticated Tandem account.
from mediator import github
from mediator.schemas.projects import DeleteProjectRequest
from mediator.db.project_deletion import delete_project as delete_saved_project
from pydantic import BaseModel, Field, ConfigDict
from fastapi.responses import RedirectResponse
from urllib.parse import urlencode


class GitHubCallbackRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: str = Field(min_length=1, max_length=1024)
    state: str = Field(min_length=1, max_length=256)


@app.post("/api/github/connect")
def github_connect(user: dict = Depends(get_current_user)):
    with plan_api_errors():
        return github.start(UUID(user["id"]))


@app.get("/api/github/callback")
def github_callback(code: str = Query(default="", max_length=1024), state: str = Query(default="", max_length=256)):
    # The browser finishes under its Auth0 session, binding GitHub authorization
    # to the same Tandem user who started it. No token appears in a redirect.
    return RedirectResponse(settings.github_dashboard_origin + "/#/projects/new?" +
                            urlencode({"github_code": code, "github_state": state}),
                            headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})


@app.post("/api/github/complete")
def github_complete(request: GitHubCallbackRequest, user: dict = Depends(get_current_user)):
    with plan_api_errors():
        return github.finish(UUID(user["id"]), request.code, request.state)


@app.get("/api/github/installations")
def github_installations(page: int = Query(default=1, ge=1, le=1000), user: dict = Depends(get_current_user)):
    with plan_api_errors():
        return github.installations(UUID(user["id"]), page)


@app.get("/api/github/installations/{installation_id}/repositories")
def github_repositories(installation_id: int, page: int = Query(default=1, ge=1, le=10000), user: dict = Depends(get_current_user)):
    if installation_id <= 0:
        raise HTTPException(422, "Invalid installation")
    with plan_api_errors():
        return github.repositories(UUID(user["id"]), installation_id, page)


@app.post("/api/projects/{project_id}/delete")
def delete_project(project_id: UUID, request: DeleteProjectRequest,
                          idempotency_key: UUID = Header(alias="Idempotency-Key"),
                          user: dict = Depends(get_current_user)):
    if idempotency_key != request.operationId:
        raise HTTPException(400, "Idempotency-Key must match operationId")
    with plan_api_errors():
        return delete_saved_project(UUID(user["id"]), project_id, request)

# Human room endpoints use dashboard authentication, never agent credentials.
from mediator.db import room as project_room
from mediator.schemas.room import ClearRoomRequest, RoomMessageRequest, WorkerRoomMessageRequest


@contextmanager
def room_api_errors():
    try:
        yield
    except agent_tasks.AgentAccessDenied as error:
        raise HTTPException(403, str(error)) from None
    except agent_tasks.AgentOperationConflict as error:
        raise HTTPException(409, str(error)) from None
    except PlannerUnavailable:
        raise HTTPException(503, 'The mediator model is not configured') from None
    except PlannerFailed:
        raise HTTPException(502, 'The mediator could not reply. Retry your message.') from None
    except DatabaseError:
        raise HTTPException(503, 'The project room is unavailable') from None


@app.get('/api/projects/{project_id}/room')
def get_project_room(project_id: UUID, user=Depends(get_current_user)):
    with room_api_errors():
        return project_room.read_room(project_id, user_id=UUID(user['id']))


@app.post('/api/projects/{project_id}/room')
def post_project_room(project_id: UUID, request: RoomMessageRequest,
                      user=Depends(get_current_user)):
    with room_api_errors():
        return project_room.post_message(project_id, request, user_id=UUID(user['id']))


@app.post('/api/projects/{project_id}/room/worker')
def post_project_room_worker(project_id: UUID, request: WorkerRoomMessageRequest,
                             user=Depends(get_current_user)):
    with room_api_errors():
        return project_room.post_worker_request(project_id, request, UUID(user['id']))


@app.delete('/api/projects/{project_id}/room')
def clear_project_room(project_id: UUID, request: ClearRoomRequest,
                       user=Depends(get_current_user)):
    with room_api_errors():
        return project_room.clear_room(project_id, request.throughId, UUID(user['id']))


@app.post('/api/projects/{project_id}/room/{exchange_id}/draft')
def save_room_draft(project_id: UUID, exchange_id: UUID, user=Depends(get_current_user)):
    with room_api_errors(), plan_api_errors():
        return project_room.save_draft(project_id, exchange_id, UUID(user['id']))
