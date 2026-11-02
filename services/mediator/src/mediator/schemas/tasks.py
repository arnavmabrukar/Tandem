from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class CreateTaskRequest(BaseModel):
    """Validate the JSON sent when creating an unassigned task."""

    # Reject unexpected fields, such as created_by or status.
    # The backend determines those values.
    model_config = ConfigDict(extra="forbid")

    # Identify this operation so retries can reuse the saved result.
    operationId: UUID

    # This is the PROJECT version the dashboard last loaded.
    # Creating a task changes the project's contents.
    expectedVersion: int = Field(ge=1, strict=True)

    # Match the title limit in our database migration.
    title: str = Field(min_length=1, max_length=200)

    # Allow an empty description, with a reasonable request-size limit.
    description: str = Field(max_length=10000)

    # Require the frontend to explicitly send "agentId": null.
    # Reject an agent ID until project-scoped assignment is implemented.
    agentId: None

    # Proposed file paths and acceptance criteria.
    # Empty lists are allowed; each list has a size limit.
    paths: list[str] = Field(max_length=100)
    criteria: list[str] = Field(max_length=100)

    # IDs of existing tasks that must finish before this task can start.
    # UUID validates each identifier's format.
    # default_factory creates a separate empty list for each request
    # and keeps existing clients working when they omit this field.
    dependencies: list[UUID] = Field(default_factory=list, max_length=100)

    @field_validator("dependencies")
    @classmethod
    def validate_dependencies(cls, values: list[UUID]) -> list[UUID]:
        # Reject duplicates instead of inserting the same relationship twice.
        # A set contains only unique values.
        if len(values) != len(set(values)):
            raise ValueError("Dependencies must not contain duplicate task IDs")

        # Dependency order has no meaning.
        # Sort consistently so reordered IDs compare equally on retries.
        return sorted(values, key=str)

    @field_validator("title")
    @classmethod
    def validate_title(cls, value: str) -> str:
        # Reject titles containing only whitespace.
        if not value.strip():
            raise ValueError("Task title must not be blank")

        # Preserve the submitted value for consistent retry comparisons.
        return value

    @field_validator("paths")
    @classmethod
    def validate_paths(cls, values: list[str]) -> list[str]:
        for path in values:
            # Require a nonempty path without surrounding whitespace.
            if not path.strip() or path != path.strip():
                raise ValueError(
                    "Paths must not be blank or have surrounding whitespace"
                )

            # Use repository-relative paths with forward slashes.
            # Reject absolute paths and Windows-style paths.
            if path.startswith("/") or "\\" in path or ":" in path:
                raise ValueError(
                    "Paths must be repository-relative with forward slashes"
                )

            # Reject parent traversal and ambiguous path segments.
            # Examples rejected: ../secret, src/../file, src//file.
            if any(part in ("", ".", "..") for part in path.split("/")):
                raise ValueError(
                    "Paths must not contain empty, '.' or '..' segments"
                )

            # Keep individual paths bounded and reject control characters.
            if len(path) > 1000 or any(
                ord(character) < 32 or ord(character) == 127
                for character in path
            ):
                raise ValueError("Path is too long or contains control characters")

        return values

    @field_validator("criteria")
    @classmethod
    def validate_criteria(cls, values: list[str]) -> list[str]:
        for criterion in values:
            # Each criterion must describe something meaningful.
            if not criterion.strip():
                raise ValueError("Acceptance criteria must not be blank")

            # Bound each individual criterion.
            if len(criterion) > 2000:
                raise ValueError(
                    "Each acceptance criterion must be at most 2000 characters"
                )

        return values


class CreateTaskResponse(BaseModel):
    """Describe the result after the task transaction commits."""

    # Identify the project containing the new task.
    projectId: UUID

    # Return the project's incremented version.
    projectVersion: int = Field(ge=1)

    # The dashboard uses this task ID to open its details.
    entityId: UUID




# CANCEL TASK
# CANCEL TASK
class CancelTaskRequest(BaseModel):
    """Validate a request to cancel an open task."""

    # Reject unexpected fields.
    # The task ID comes from the URL, not the JSON body.
    model_config = ConfigDict(extra="forbid")

    # Identify this cancellation so retries can return its saved result.
    operationId: UUID

    # The project version last seen by the dashboard.
    # The database function will reject stale requests.
    expectedVersion: int = Field(ge=1, strict=True)


class CancelTaskResponse(BaseModel):
    """Describe the committed cancellation."""

    # Identify the project containing the task.
    projectId: UUID

    # Cancellation changes the project, so its version increases.
    projectVersion: int = Field(ge=1)

    # Identify the task that was cancelled.
    entityId: UUID
