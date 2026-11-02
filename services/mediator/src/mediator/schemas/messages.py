from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class CreateMessageRequest(BaseModel):
    """Validate a human note posted to a task thread."""

    # Reject caller-supplied sender IDs, names, or message types.
    # The backend determines identity and sets type='human_note'.
    model_config = ConfigDict(extra="forbid")

    # Identify this operation so retries do not create duplicate messages.
    operationId: UUID

    # The project version last loaded by the dashboard.
    expectedVersion: int = Field(ge=1, strict=True)

    # Require a nonempty message and limit its size.
    body: str = Field(min_length=1, max_length=10000)

    # Require an explicit reply target or JSON null for a new message.
    # Existing message IDs are TEXT, so do not restrict them to UUIDs.
    replyTo: str | None = Field(min_length=1, max_length=200)

    @field_validator("body")
    @classmethod
    def validate_body(cls, value: str) -> str:
        # A message consisting entirely of whitespace is not useful.
        if not value.strip():
            raise ValueError("Message body must not be blank")

        # PostgreSQL TEXT cannot store a null character.
        if "\x00" in value:
            raise ValueError("Message body must not contain null characters")

        # Preserve whitespace and newlines in the user's message.
        # This also keeps retry comparisons consistent.
        return value

    @field_validator("replyTo")
    @classmethod
    def validate_reply_target(cls, value: str | None) -> str | None:
        # null means this message is not replying to another message.
        if value is None:
            return None

        # Reject blank IDs and accidental surrounding whitespace.
        if not value.strip() or value != value.strip():
            raise ValueError("Reply target must be a nonblank message ID")

        if "\x00" in value:
            raise ValueError("Reply target must not contain null characters")

        # Existence and same-task ownership are checked in the transaction.
        return value


class CreateMessageResponse(BaseModel):
    """Describe the committed message creation."""

    # Identify the project whose thread changed.
    projectId: UUID

    # Return the project's incremented version.
    projectVersion: int = Field(ge=1)

    # Messages use TEXT identifiers in the existing database schema.
    entityId: str = Field(min_length=1)