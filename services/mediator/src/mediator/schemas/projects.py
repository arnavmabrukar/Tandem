from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class CreateProjectRequest(BaseModel):
    """Validate the JSON sent when someone creates a project."""

    # Reject unknown fields, such as owner_id.
    # We determine ownership from the authenticated user.
    model_config = ConfigDict(extra="forbid")

    # The frontend generates this ID to identify the operation.
    # Retrying the same operation must reuse this ID.
    operationId: UUID

    # New projects have no previous version.
    # The frontend must explicitly send "expectedVersion": null.
    expectedVersion: None

    # Require a name between 1 and 80 characters.
    name: str = Field(min_length=1, max_length=80)

    # Require owner/repository format, matching the frontend.
    # This validates the format, not whether the repository exists.
    repository: str = Field(
        pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_.\-]*/[a-zA-Z0-9][a-zA-Z0-9_.\-]*$",
    )

    # An empty description is valid, but the field is required.
    description: str = Field(max_length=1000)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        # A string of spaces has a length, but isn't a useful name.
        if not value.strip():
            raise ValueError("Project name must not be blank")

        # Preserve the original text for consistent retry comparisons.
        return value


class CreateProjectResponse(BaseModel):
    """Describe the successful response returned after saving."""

    # The internal ID of the saved project.
    projectId: UUID

    # Project versions start at 1.
    projectVersion: int = Field(ge=1)

    # The entity created by this operation is the project itself.
    entityId: UUID

class UpdateProjectRequest(BaseModel):
    """Validate edits to an existing project."""

    # Reject unexpected fields, including caller-supplied ownership.
    model_config = ConfigDict(extra="forbid")

    # Identify this edit so an identical retry can reuse its result.
    operationId: UUID

    # The version the user saw before editing.
    # Unlike creation, this must be a positive integer—not null.
    # strict=True rejects strings and booleans masquerading as integers.
    expectedVersion: int = Field(ge=1, strict=True)

    # The frontend sends all three editable fields when saving.
    name: str = Field(min_length=1, max_length=80)

    # Require owner/repository format.
    repository: str = Field(
        pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_.\-]*/[a-zA-Z0-9][a-zA-Z0-9_.\-]*$",
    )

    # Empty descriptions are allowed.
    description: str = Field(max_length=1000)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        # Reject names made entirely of whitespace.
        if not value.strip():
            raise ValueError("Project name must not be blank")
        return value