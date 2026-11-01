from typing import Literal
from uuid import UUID

# Represent invitation expiration timestamps.
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator


class CreateInvitationRequest(BaseModel):
    """Validate an owner's request to invite someone."""

    # Reject unexpected fields, including caller-supplied inviter IDs.
    model_config = ConfigDict(extra="forbid")

    # Identify this action so retries cannot create duplicate invitations.
    operationId: UUID

    # Require the project version the owner saw before submitting.
    expectedVersion: int = Field(ge=1, strict=True)

    # Validate email syntax. This does NOT prove ownership of the address.
    email: EmailStr

    # Accept only roles supported by Tandem.
    role: Literal["owner", "reviewer", "viewer"]

    @field_validator("email", mode="before")
    @classmethod
    def normalize_email(cls, value: object) -> object:
        # Match the lowercase, trimmed representation in our SQL table.
        # Do not remove dots or plus-address suffixes.
        if isinstance(value, str):
            return value.strip().lower()
        return value


class RevokeInvitationRequest(BaseModel):
    """Validate an owner's request to revoke a pending invitation."""

    model_config = ConfigDict(extra="forbid")

    # Revocation also needs retry protection.
    operationId: UUID

    # Prevent applying the action against outdated project state.
    expectedVersion: int = Field(ge=1, strict=True)


class InvitationMutationResponse(BaseModel):
    """Return the committed outcome of invitation creation or revocation."""

    projectId: UUID

    # Creating or revoking an invitation increments the project version.
    projectVersion: int = Field(ge=1)

    # Identify the invitation that was created or revoked.
    entityId: UUID

class PendingInvitation(BaseModel):
    """Information a recipient needs before accepting."""

    id: UUID
    projectId: UUID
    projectName: str

    # Show which address and role the invitation targets.
    email: EmailStr
    role: Literal["owner", "reviewer", "viewer"]
    expiresAt: datetime


class PendingInvitationsResponse(BaseModel):
    # An empty list means no unexpired pending invitations were found.
    invitations: list[PendingInvitation]

class AcceptInvitationRequest(BaseModel):
    """Identify an acceptance operation for safe retries."""

    model_config = ConfigDict(extra="forbid")

    # The frontend generates this ID and reuses it for retries.
    operationId: UUID