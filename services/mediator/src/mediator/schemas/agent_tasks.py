"""Input types for the MCP project tools."""
from typing import Annotated, Literal

from pydantic import AfterValidator, Field

# Agents may only report on their own work. Approving, merging, and cancelling
# remain human decisions, so those statuses cannot be requested at all.
AgentTaskStatus = Literal["in_progress", "in_review", "blocked"]

# 'human_note' is reserved for messages posted by signed-in people.
AgentMessageType = Literal["question", "answer", "status", "result"]

TaskStatusFilter = Literal[
    "open", "claimed", "in_progress", "in_review", "approved",
    "merged", "blocked", "conflict", "cancelled",
]


def _storable_text(value: str) -> str:
    # A whitespace-only update says nothing useful.
    if not value.strip():
        raise ValueError("Text must not be blank")
    # PostgreSQL TEXT cannot store a null character.
    if "\x00" in value:
        raise ValueError("Text must not contain null characters")
    return value


ProgressText = Annotated[str, Field(min_length=1, max_length=2000), AfterValidator(_storable_text)]
MessageBody = Annotated[str, Field(min_length=1, max_length=10000), AfterValidator(_storable_text)]
ReplyTarget = Annotated[str, Field(min_length=1, max_length=200), AfterValidator(_storable_text)]
