from uuid import UUID

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from mediator.config import settings
from mediator.db.projects import (
    OperationConflict,
    ProjectAccessDenied,
    ProjectVersionConflict,
)
from mediator.schemas.invitations import (
    AcceptInvitationRequest,
    CreateInvitationRequest,
    RevokeInvitationRequest,
    InvitationMutationResponse,
)


class InvitationConflict(Exception):
    """A pending invitation already exists for this email and project."""

class InvitationNotFound(Exception):
    """The invitation does not belong to the requested project."""


def create_invitation(
    actor_id: UUID,
    project_id: UUID,
    request: CreateInvitationRequest,
) -> InvitationMutationResponse:
    """Create an invitation with ownership, version, and retry checks."""

    if settings.database_url is None:
        raise RuntimeError("DATABASE_URL is not configured")

    database_url = settings.database_url.get_secret_value()
    if not database_url.strip():
        raise RuntimeError("DATABASE_URL is empty")

    # Include the target project when comparing repeated requests.
    payload = {
        "projectId": str(project_id),
        **request.model_dump(mode="json"),
    }

    with psycopg.connect(
        database_url,
        connect_timeout=10,
        row_factory=dict_row,
    ) as connection:
        connection.execute(
            "SET TRANSACTION ISOLATION LEVEL READ COMMITTED"
        )

        # Reserve the operation before performing any changes.
        reservation = connection.execute(
            """
            INSERT INTO public.operations (
                actor_id, operation_id, operation_type, request_payload
            )
            VALUES (%s, %s, 'create_invitation', %s)
            ON CONFLICT (actor_id, operation_id) DO NOTHING
            RETURNING operation_id
            """,
            (actor_id, request.operationId, Jsonb(payload)),
        ).fetchone()

        # Require current owner access, including on a retry.
        # Keep that membership stable until this transaction finishes.
        membership = connection.execute(
            """
            SELECT role
            FROM public.project_memberships
            WHERE project_id = %s AND user_id = %s
            FOR SHARE
            """,
            (project_id, actor_id),
        ).fetchone()

        if membership is None or membership["role"] != "owner":
            raise ProjectAccessDenied("Project owner access is required")

        if reservation is None:
            # Return a previously committed result for an identical request.
            existing = connection.execute(
                """
                SELECT operation_type, request_payload, response_payload
                FROM public.operations
                WHERE actor_id = %s AND operation_id = %s
                """,
                (actor_id, request.operationId),
            ).fetchone()

            if existing is None:
                raise RuntimeError("Reserved operation could not be found")

            if (
                existing["operation_type"] != "create_invitation"
                or existing["request_payload"] != payload
            ):
                raise OperationConflict(
                    "Operation ID was already used for another request"
                )

            if existing["response_payload"] is None:
                raise RuntimeError("Operation has no saved response")

            # Replay before checking the old expectedVersion.
            result = InvitationMutationResponse.model_validate(
                existing["response_payload"]
            )

        else:
            # Atomically check the version and advance it.
            # This also locks the project row until the transaction ends.
            project = connection.execute(
                """
                UPDATE public.projects
                SET version = version + 1
                WHERE id = %s AND version = %s
                RETURNING id, version
                """,
                (project_id, request.expectedVersion),
            ).fetchone()

            if project is None:
                raise ProjectVersionConflict(
                    "Project changed; reload before inviting"
                )

            # Expired invitations still have status 'pending'.
            # Revoke an expired invitation for this address so a new one
            # can be created without violating the unique pending index.
            connection.execute(
                """
                UPDATE public.project_invitations
                SET status = 'revoked', revoked_at = clock_timestamp()
                WHERE project_id = %s
                  AND email = %s
                  AND status = 'pending'
                  AND expires_at <= clock_timestamp()
                """,
                (project_id, str(request.email)),
            )

            # The partial unique index prevents duplicate pending invites.
            # If an unexpired pending invite exists, return no inserted row.
            invitation = connection.execute(
                """
                INSERT INTO public.project_invitations (
                    project_id, email, role, invited_by
                )
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (project_id, email)
                    WHERE status = 'pending'
                DO NOTHING
                RETURNING id
                """,
                (
                    project_id,
                    str(request.email),
                    request.role,
                    actor_id,
                ),
            ).fetchone()

            if invitation is None:
                # This exception rolls back the version increment too.
                raise InvitationConflict(
                    "A pending invitation already exists for this email"
                )

            result = InvitationMutationResponse(
                projectId=project["id"],
                projectVersion=project["version"],
                entityId=invitation["id"],
            )

            # Save the successful response in the same transaction.
            connection.execute(
                """
                UPDATE public.operations
                SET response_payload = %s
                WHERE actor_id = %s AND operation_id = %s
                """,
                (
                    Jsonb(result.model_dump(mode="json")),
                    actor_id,
                    request.operationId,
                ),
            )

    # Commit before returning. Any exception above rolls everything back.
    return result



# REVOKE
def revoke_invitation(
    actor_id: UUID,
    project_id: UUID,
    invitation_id: UUID,
    request: RevokeInvitationRequest,
) -> InvitationMutationResponse:
    """Cancel a pending invitation with authorization and retry checks."""

    if settings.database_url is None:
        raise RuntimeError("DATABASE_URL is not configured")

    database_url = settings.database_url.get_secret_value()
    if not database_url.strip():
        raise RuntimeError("DATABASE_URL is empty")

    # Include both URL IDs when comparing retries.
    payload = {
        "projectId": str(project_id),
        "invitationId": str(invitation_id),
        **request.model_dump(mode="json"),
    }

    with psycopg.connect(
        database_url,
        connect_timeout=10,
        row_factory=dict_row,
    ) as connection:
        connection.execute(
            "SET TRANSACTION ISOLATION LEVEL READ COMMITTED"
        )

        # Reserve this operation before changing anything.
        reservation = connection.execute(
            """
            INSERT INTO public.operations (
                actor_id, operation_id, operation_type, request_payload
            )
            VALUES (%s, %s, 'revoke_invitation', %s)
            ON CONFLICT (actor_id, operation_id) DO NOTHING
            RETURNING operation_id
            """,
            (actor_id, request.operationId, Jsonb(payload)),
        ).fetchone()

        # Check current owner access, including on retries.
        membership = connection.execute(
            """
            SELECT role
            FROM public.project_memberships
            WHERE project_id = %s AND user_id = %s
            FOR SHARE
            """,
            (project_id, actor_id),
        ).fetchone()

        if membership is None or membership["role"] != "owner":
            raise ProjectAccessDenied("Project owner access is required")

        if reservation is None:
            # An identical successful retry returns its original result.
            existing = connection.execute(
                """
                SELECT operation_type, request_payload, response_payload
                FROM public.operations
                WHERE actor_id = %s AND operation_id = %s
                """,
                (actor_id, request.operationId),
            ).fetchone()

            if existing is None:
                raise RuntimeError("Reserved operation could not be found")

            if (
                existing["operation_type"] != "revoke_invitation"
                or existing["request_payload"] != payload
            ):
                raise OperationConflict(
                    "Operation ID was already used for another request"
                )

            if existing["response_payload"] is None:
                raise RuntimeError("Operation has no saved response")

            result = InvitationMutationResponse.model_validate(
                existing["response_payload"]
            )

        else:
            # Check the project version and lock its row.
            # All invitation mutations must lock the project before
            # locking the invitation, including the future acceptance flow.
            project = connection.execute(
                """
                UPDATE public.projects
                SET version = version + 1
                WHERE id = %s AND version = %s
                RETURNING id, version
                """,
                (project_id, request.expectedVersion),
            ).fetchone()

            if project is None:
                raise ProjectVersionConflict(
                    "Project changed; reload before revoking"
                )

            # Scope the lookup to this project, not just invitation ID.
            # Lock the invitation while checking and changing its state.
            invitation = connection.execute(
                """
                SELECT status
                FROM public.project_invitations
                WHERE id = %s AND project_id = %s
                FOR UPDATE
                """,
                (invitation_id, project_id),
            ).fetchone()

            if invitation is None:
                raise InvitationNotFound("Invitation not found")

            if invitation["status"] != "pending":
                # Accepted memberships require a separate removal action.
                # Already-revoked invitations need no second revocation.
                raise InvitationConflict("Invitation is no longer pending")

            connection.execute(
                """
                UPDATE public.project_invitations
                SET status = 'revoked', revoked_at = clock_timestamp()
                WHERE id = %s AND project_id = %s
                """,
                (invitation_id, project_id),
            )

            result = InvitationMutationResponse(
                projectId=project_id,
                projectVersion=project["version"],
                entityId=invitation_id,
            )

            # Save the result in the same transaction as revocation.
            connection.execute(
                """
                UPDATE public.operations
                SET response_payload = %s
                WHERE actor_id = %s AND operation_id = %s
                """,
                (
                    Jsonb(result.model_dump(mode="json")),
                    actor_id,
                    request.operationId,
                ),
            )

    # Commit everything before returning.
    # Any exception rolls back the version change and reservation too.
    return result

def list_pending_invitations(verified_email: str) -> dict:
    """Find unexpired invitations for an Auth0-verified email."""

    if settings.database_url is None:
        raise RuntimeError("DATABASE_URL is not configured")

    database_url = settings.database_url.get_secret_value()
    if not database_url.strip():
        raise RuntimeError("DATABASE_URL is empty")

    with psycopg.connect(
        database_url,
        connect_timeout=10,
        row_factory=dict_row,
    ) as connection:
        invitations = connection.execute(
            """
            SELECT
                invitation.id,
                invitation.project_id AS "projectId",
                project.name AS "projectName",
                invitation.email,
                invitation.role,
                invitation.expires_at AS "expiresAt"
            FROM public.project_invitations AS invitation
            JOIN public.projects AS project
                ON project.id = invitation.project_id
            WHERE invitation.email = %s
              AND invitation.status = 'pending'
              AND invitation.expires_at > statement_timestamp()
            ORDER BY invitation.created_at, invitation.id
            """,
            # This must come from our verified-email dependency.
            # Never accept a recipient email from a query parameter.
            (verified_email,),
        ).fetchall()

    return {"invitations": invitations}


def accept_invitation(
    actor_id: UUID,
    verified_email: str,
    invitation_id: UUID,
    request: AcceptInvitationRequest,
) -> InvitationMutationResponse:
    """Accept an invitation for the authenticated, verified recipient."""

    if settings.database_url is None:
        raise RuntimeError("DATABASE_URL is not configured")

    database_url = settings.database_url.get_secret_value()
    if not database_url.strip():
        raise RuntimeError("DATABASE_URL is empty")

    # Bind retries to this invitation.
    # actor_id scopes the operation to the authenticated user.
    payload = {
        "invitationId": str(invitation_id),
        **request.model_dump(mode="json"),
    }

    with psycopg.connect(
        database_url,
        connect_timeout=10,
        row_factory=dict_row,
    ) as connection:
        connection.execute(
            "SET TRANSACTION ISOLATION LEVEL READ COMMITTED"
        )

        reservation = connection.execute(
            """
            INSERT INTO public.operations (
                actor_id, operation_id, operation_type, request_payload
            )
            VALUES (%s, %s, 'accept_invitation', %s)
            ON CONFLICT (actor_id, operation_id) DO NOTHING
            RETURNING operation_id
            """,
            (actor_id, request.operationId, Jsonb(payload)),
        ).fetchone()

        # Discover the project only if the invitation targets this email.
        # The email must come from Auth0, never from the request body.
        target = connection.execute(
            """
            SELECT project_id
            FROM public.project_invitations
            WHERE id = %s AND email = %s
            """,
            (invitation_id, verified_email),
        ).fetchone()

        if target is None:
            raise InvitationNotFound("Invitation not found")

        project_id = target["project_id"]

        # Lock the project before the invitation, matching revocation.
        # Acceptance and revocation cannot both succeed.
        project = connection.execute(
            """
            SELECT id
            FROM public.projects
            WHERE id = %s
            FOR UPDATE
            """,
            (project_id,),
        ).fetchone()

        if project is None:
            raise InvitationNotFound("Invitation not found")

        invitation = connection.execute(
            """
            SELECT status, role, accepted_by, expires_at
            FROM public.project_invitations
            WHERE id = %s AND project_id = %s AND email = %s
            FOR UPDATE
            """,
            (invitation_id, project_id, verified_email),
        ).fetchone()

        if invitation is None:
            raise InvitationNotFound("Invitation not found")

        if reservation is None:
            # An identical retry must return the original committed result.
            existing = connection.execute(
                """
                SELECT operation_type, request_payload, response_payload
                FROM public.operations
                WHERE actor_id = %s AND operation_id = %s
                """,
                (actor_id, request.operationId),
            ).fetchone()

            if existing is None:
                raise RuntimeError("Reserved operation could not be found")

            if (
                existing["operation_type"] != "accept_invitation"
                or existing["request_payload"] != payload
            ):
                raise OperationConflict(
                    "Operation ID was already used for another request"
                )

            # A retry must not recreate membership after its removal.
            membership = connection.execute(
                """
                SELECT role
                FROM public.project_memberships
                WHERE project_id = %s AND user_id = %s
                FOR SHARE
                """,
                (project_id, actor_id),
            ).fetchone()

            if (
                membership is None
                or invitation["status"] != "accepted"
                or invitation["accepted_by"] != actor_id
            ):
                raise ProjectAccessDenied(
                    "Accepted project membership is unavailable"
                )

            if existing["response_payload"] is None:
                raise RuntimeError("Operation has no saved response")

            result = InvitationMutationResponse.model_validate(
                existing["response_payload"]
            )

        else:
            if invitation["status"] != "pending":
                raise InvitationConflict(
                    "Invitation is no longer pending"
                )

            # Check expiration after acquiring the locks.
            # clock_timestamp() uses the current time, even after waiting.
            updated = connection.execute(
                """
                UPDATE public.project_invitations
                SET
                    status = 'accepted',
                    accepted_by = %s,
                    accepted_at = clock_timestamp()
                WHERE id = %s
                  AND status = 'pending'
                  AND expires_at > clock_timestamp()
                RETURNING id
                """,
                (actor_id, invitation_id),
            ).fetchone()

            if updated is None:
                raise InvitationConflict("Invitation has expired")

            # Add membership without overwriting any existing role.
            membership = connection.execute(
                """
                INSERT INTO public.project_memberships (
                    project_id, user_id, role
                )
                VALUES (%s, %s, %s)
                ON CONFLICT (project_id, user_id) DO NOTHING
                RETURNING user_id
                """,
                (project_id, actor_id, invitation["role"]),
            ).fetchone()

            if membership is None:
                # This also rolls back the invitation's accepted status.
                raise InvitationConflict(
                    "You are already a member of this project"
                )

            # Membership changed, so advance the workspace's project version.
            project = connection.execute(
                """
                UPDATE public.projects
                SET version = version + 1
                WHERE id = %s
                RETURNING version
                """,
                (project_id,),
            ).fetchone()

            if project is None:
                raise RuntimeError("Project disappeared during acceptance")

            result = InvitationMutationResponse(
                projectId=project_id,
                projectVersion=project["version"],
                entityId=invitation_id,
            )

            connection.execute(
                """
                UPDATE public.operations
                SET response_payload = %s
                WHERE actor_id = %s AND operation_id = %s
                """,
                (
                    Jsonb(result.model_dump(mode="json")),
                    actor_id,
                    request.operationId,
                ),
            )

    # Membership, invitation state, version, and response commit together.
    return result