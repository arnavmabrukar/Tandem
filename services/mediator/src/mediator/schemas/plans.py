"""Shared format for human-edited and model-proposed plans.

Validation makes a proposal structurally valid; it does not authorize work.
The service must check project membership and obtain human approval separately.
"""
from typing import Annotated, Self
from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from mediator.schemas.tasks import CreateTaskRequest


# Keys exist only inside a proposal. Live task UUIDs are assigned on approval.
TaskKey = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_-]{0,63}$")]


class ProposedTask(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: TaskKey
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=10000)
    contractSummary: str = Field(min_length=1, max_length=2000)
    paths: list[str] = Field(default_factory=list, max_length=100)
    criteria: list[str] = Field(min_length=1, max_length=100)
    dependencies: list[TaskKey] = Field(default_factory=list, max_length=49)

    @field_validator("title", "contractSummary")
    @classmethod
    def meaningful_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Text must not be blank")
        return value

    @field_validator("title", "description", "contractSummary")
    @classmethod
    def postgres_text(cls, value: str) -> str:
        if "\x00" in value:
            raise ValueError("Text must not contain NUL characters")
        return value

    @field_validator("paths")
    @classmethod
    def safe_paths(cls, values: list[str]) -> list[str]:
        # Apply the same repository path rules as manually created tasks.
        return CreateTaskRequest.validate_paths(values)

    @field_validator("criteria")
    @classmethod
    def meaningful_criteria(cls, values: list[str]) -> list[str]:
        for value in values:
            cls.postgres_text(value)
        return CreateTaskRequest.validate_criteria(values)

    @field_validator("dependencies")
    @classmethod
    def unique_dependencies(cls, values: list[str]) -> list[str]:
        if len(values) != len(set(values)):
            raise ValueError("Dependencies must be unique")
        return sorted(values)


class PlanProposal(BaseModel):
    """The content a model can propose and a human can edit."""
    model_config = ConfigDict(extra="forbid")

    goal: str = Field(min_length=1, max_length=10000)
    summary: str = Field(min_length=1, max_length=4000)
    tasks: list[ProposedTask] = Field(min_length=1, max_length=50)

    @field_validator("goal", "summary")
    @classmethod
    def meaningful_text(cls, value: str) -> str:
        ProposedTask.meaningful_text(value)
        return ProposedTask.postgres_text(value)

    @model_validator(mode="after")
    def validate_graph(self) -> Self:
        by_key = {task.key: task for task in self.tasks}
        if len(by_key) != len(self.tasks):
            raise ValueError("Each proposed task must have a unique key")

        for task in self.tasks:
            if task.key in task.dependencies:
                raise ValueError("A task cannot depend on itself")
            if any(key not in by_key for key in task.dependencies):
                raise ValueError("Dependencies must reference tasks in this proposal")

        # A visiting task is on the current search path. Finding it again
        # means a cycle, which would leave those tasks waiting forever.
        visiting: set[str] = set()
        visited: set[str] = set()

        def visit(key: str) -> None:
            if key in visiting:
                raise ValueError("Task dependencies must not contain cycles")
            if key in visited:
                return
            visiting.add(key)
            for dependency in by_key[key].dependencies:
                visit(dependency)
            visiting.remove(key)
            visited.add(key)

        for key in by_key:
            visit(key)
        return self


class CreatePlanRequest(BaseModel):
    """Human/API envelope; these fields do not come from model output."""
    model_config = ConfigDict(extra="forbid")

    operationId: UUID
    expectedVersion: int = Field(ge=1, strict=True)  # Project version.
    proposal: PlanProposal


class RevisePlanRequest(CreatePlanRequest):
    # Compare both versions so edits cannot overwrite another person's work.
    expectedPlanVersion: int = Field(ge=1, strict=True)


class SavePlanResponse(BaseModel):
    projectId: UUID
    projectVersion: int = Field(ge=1)
    planId: UUID
    planVersion: int = Field(ge=1)


class PlanRevisionResponse(SavePlanResponse):
    # projectVersion is the version recorded when this revision was saved.
    createdBy: UUID
    createdAt: datetime
    proposal: PlanProposal
    approvedPlanVersion: int | None = None


class ApprovePlanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operationId: UUID
    expectedVersion: int = Field(ge=1, strict=True)
    expectedPlanVersion: int = Field(ge=1, strict=True)
    note: str = Field(min_length=1, max_length=2000)

    @field_validator("note")
    @classmethod
    def meaningful_note(cls, value: str) -> str:
        ProposedTask.meaningful_text(value)
        return ProposedTask.postgres_text(value)


class ApprovePlanResponse(SavePlanResponse):
    taskIds: dict[str, UUID]


class GeneratePlanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    goal: str = Field(min_length=1, max_length=10000)

    @field_validator("goal")
    @classmethod
    def valid_goal(cls, value: str) -> str:
        return PlanProposal.meaningful_text(value)
