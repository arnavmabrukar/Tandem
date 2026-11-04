"""Clients provide message text, never an identity or visibility setting."""
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field, field_validator
from mediator.schemas.plans import PlanChatResponse


class RoomMessageRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operationId: UUID
    body: str = Field(min_length=1, max_length=8000)

    @field_validator("body")
    @classmethod
    def meaningful(cls, value: str) -> str:
        if not value.strip() or "\x00" in value:
            raise ValueError("Enter a message without null characters")
        return value.strip()


class ClearRoomRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    throughId: UUID


class RoomReply(PlanChatResponse):
    requestPresence: bool = False
    # The mediator writes a separate, scoped request for the worker. The human
    # room message itself is never exposed through MCP.
    relayTaskId: UUID | None = None
    relayMessage: str | None = Field(default=None, max_length=8000)
    # Suggestions only; existing cancellation permissions/version checks still apply.
    cancelTaskIds: list[UUID] = Field(default_factory=list, max_length=20)
