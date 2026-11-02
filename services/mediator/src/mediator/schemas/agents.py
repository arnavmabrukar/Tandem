"""Validate dashboard requests before the backend registers an agent."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class RegisterAgentRequest(BaseModel):
    # Reject caller-supplied identities, token hashes, and grant statuses.
    # The backend will determine those values itself.
    model_config = ConfigDict(extra="forbid")

    # Reuse this ID when retrying the same registration request.
    operationId: UUID

    # Reject registration based on an outdated project version.
    expectedVersion: int = Field(ge=1, strict=True)

    name: str = Field(min_length=1, max_length=80)
    client: Literal["Codex", "Claude Code", "Other"]

    # Kept for compatibility with the existing dashboard payload.
    # This is NOT an identity or permission claim. The backend must derive
    # owner_user_id and the saved owner display name from the signed-in user.
    owner: str = Field(max_length=200)

    # Optional descriptive metadata, never proof of the machine's identity.
    machine: str = Field(max_length=200)

    # These labels describe skills; they do not grant tool permissions.
    capabilities: list[Annotated[str, Field(min_length=1, max_length=80)]] = Field(
        max_length=20,
    )

    @field_validator("name", "owner", "machine")
    @classmethod
    def validate_text(cls, value: str) -> str:
        # PostgreSQL text cannot contain a NUL character.
        if "\x00" in value:
            raise ValueError("Text must not contain NUL characters")
        return value

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Agent name must not be blank")
        # Preserve submitted text so retry payload comparisons are consistent.
        return value

    @field_validator("capabilities")
    @classmethod
    def validate_capabilities(cls, values: list[str]) -> list[str]:
        for value in values:
            if not value.strip() or "\x00" in value:
                raise ValueError("Capabilities must be nonblank text without NUL")
        return values


class RegisterAgentResponse(BaseModel):
    # Match the dashboard's existing mutation response format.
    projectId: UUID
    projectVersion: int = Field(ge=1)

    # The existing agents table uses TEXT IDs, not a PostgreSQL UUID column.
    entityId: str = Field(min_length=1)

    # Credentials are intentionally absent from this replayable response.
    # Token issuance will use a separate flow so raw tokens are not persisted
    # in the operations table's saved JSON responses.


class IssueAgentTokenRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operationId: UUID
    expectedVersion: int = Field(ge=1, strict=True)


class IssueAgentTokenResponse(RegisterAgentResponse):
    # Hide credentials from Python repr/logging of this model. The JSON
    # response deliberately includes it once for the authenticated owner.
    token: str = Field(min_length=1, repr=False)
