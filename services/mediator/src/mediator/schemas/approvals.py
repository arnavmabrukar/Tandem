from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ContractApprovalTarget(BaseModel):
    """Identify the exact task contract the human reviewed."""

    # Reject extra fields rather than silently ignoring them.
    model_config = ConfigDict(extra="forbid")

    # Only contract decisions are implemented in this first version.
    action: Literal["Approve contract"]

    # Compare this with the current project repository before saving.
    repository: str = Field(min_length=1)

    # Both versions must still match when the decision is saved.
    taskVersion: int = Field(ge=1, strict=True)
    contractVersion: int = Field(ge=1, strict=True)

    # Contract approval has no code target; require explicit JSON null.
    head: None


class DecideContractRequest(BaseModel):
    """Validate a human decision on a pending contract approval."""

    model_config = ConfigDict(extra="forbid")

    # Reuse this ID when retrying the same decision.
    operationId: UUID

    # The project version last loaded by the dashboard.
    expectedVersion: int = Field(ge=1, strict=True)

    # Humans may approve or reject the proposed contract.
    decision: Literal["approved", "rejected"]

    # Match the review-note limit in the existing dialog.
    note: str = Field(min_length=1, max_length=2000)

    # Validate the nested target object using the model above.
    target: ContractApprovalTarget

    @field_validator("note")
    @classmethod
    def validate_note(cls, value: str) -> str:
        # Require an explanation containing more than whitespace.
        if not value.strip():
            raise ValueError("A review note is required")

        # PostgreSQL TEXT cannot store null characters.
        if "\x00" in value:
            raise ValueError("Review note must not contain null characters")

        # Preserve the original text for consistent retry comparisons.
        return value


class DecideContractResponse(BaseModel):
    """Describe the successfully committed approval decision."""

    projectId: UUID

    # Recording the decision advances the project version.
    projectVersion: int = Field(ge=1)

    # Identify the approval record that received the decision.
    entityId: UUID
