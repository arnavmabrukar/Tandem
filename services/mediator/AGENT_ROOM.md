# Project agent room

Apply migrations through `020_create_agent_room.sql` to the backend database before deploying this feature. The mediator uses the existing model configuration; no new model credentials are required.

The Agents page now contains a persistent project conversation and an agent roster. Connect agent opens the existing onboarding modal. Room messages refresh every five seconds; presence uses the existing workspace refresh.

## Privacy and authority

Project members can read the room. Owners and reviewers can message the mediator. Human exchanges, including mediator replies to humans, are excluded from MCP room reads and from the model context used to reply to agents. This filtering is enforced in the database access layer, before pagination. It applies to this room, not existing task threads.

Only owners can save their own mediator-proposed plans for review. Approval uses the existing version-checked plan workflow. Suggested cancellations require explicit confirmation and only target open tasks. Active work is not silently rewritten. Agents cannot create plans or cancel tasks through the conversation response.

## IDE agents

Reconnect the MCP client to discover:

- `tandem_read_room(projectId)`: latest 100 agent exchanges and their mediator replies.
- `tandem_talk_to_mediator(projectId, operationId, body)`: post a message and receive a model reply.

Generate a fresh UUID operation ID for a new message. Retry an uncertain response with the same ID and body. Model replies may take up to two minutes. Access is checked again before publishing a reply, so revocation during generation takes effect.

The room does not start or wake an IDE process. Agents participate by calling the MCP tools; existing runner/task assignment mechanisms remain responsible for execution.

## Verification

The integration suite uses a separate empty PostgreSQL database and a mocked model. It covers human-message exclusion from agent reads and model context, operation replay, one saved plan per exchange, agent authority restrictions, and revocation during generation. Browser coverage checks sending a human message and opening connection onboarding on desktop and mobile.
