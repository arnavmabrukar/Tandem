from typing import Literal
from uuid import UUID

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