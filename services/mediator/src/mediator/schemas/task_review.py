"""Requests for human decisions on an agent's work."""
from typing import Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


def _storable_note(value: str | None) -> str | None:
    if value is None:
        return None
    if not value.strip():
        raise ValueError("Note must not be blank")
    if "\x00" in value:
        raise ValueError("Note must not contain null characters")
    return value


class ReviewTaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    operationId: UUID
    expectedVersion: int = Field(ge=1, strict=True)  # Project version.
    decision: Literal["accept", "request_changes"]
    note: str | None = Field(default=None, max_length=10000)

    _note = field_validator("note")(_storable_note)

    @model_validator(mode="after")
    def changes_need_an_explanation(self) -> Self:
        # The agent receives this note as its instructions for the next attempt.
        if self.decision == "request_changes" and self.note is None:
            raise ValueError("Explain what needs to change")
        return self


class ReleaseTaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    operationId: UUID
    expectedVersion: int = Field(ge=1, strict=True)  # Project version.
    note: str | None = Field(default=None, max_length=10000)

    _note = field_validator("note")(_storable_note)


class TaskDecisionResponse(BaseModel):
    projectId: UUID
    projectVersion: int = Field(ge=1)
    entityId: UUID
    taskVersion: int = Field(ge=1)
    status: str
