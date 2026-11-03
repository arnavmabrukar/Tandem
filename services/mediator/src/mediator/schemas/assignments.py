from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field, model_validator


class AssignTaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operationId: UUID
    # Dashboard mutations compare the project version, not the task version.
    expectedVersion: int = Field(ge=1, strict=True)
    # Null releases an assignment. It never releases an active claim.
    agentId: str | None = Field(max_length=200)

    # Ask the mediator to choose; never accept both an explicit agent and auto mode.
    autoSelect: bool = Field(default=False, strict=True)

    @model_validator(mode="after")
    def validate_selection(self):
        if self.autoSelect and self.agentId is not None:
            raise ValueError("Provide agentId or autoSelect, not both")
        return self


class AutoDelegateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operationId: UUID
    expectedVersion: int = Field(ge=1, strict=True)
    enabled: bool = Field(strict=True)
