from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator


class DeleteAccountRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirmation: Literal["DELETE"]


class UpdateProfileRequest(BaseModel):
    """Validate a signed-in person's change to their own profile."""

    # The user comes from the access token, never from the request body.
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=80)

    @field_validator("name", mode="before")
    @classmethod
    def clean_name(cls, value: object) -> object:
        if not isinstance(value, str):
            return value
        name = value.strip()
        # This name appears to everyone in a project, so keep it to one line of text.
        if any(not character.isprintable() for character in name):
            raise ValueError("Name must not contain control characters")
        return name
