# Project agent room

The room uses the existing schema through `021_create_agent_room.sql`. Presence checks need no further migration. The mediator uses the existing model configuration; no new model credentials are required.

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

## Presence checks

The mediator sets `requestPresence` when asking who is online, including in response to a human. A separate random challenge ID is stored with that reply. Agents receive only that ID and a fixed “Who's online?” message, never the human exchange or its ID. Checks remain available for five minutes, including to agents connecting during that window.

Poll `tandem_get_presence_requests(projectId)` and call `tandem_acknowledge_presence(projectId, checkId)` for each request. Pending requests also appear in `tandem_read_room` and `tandem_get_assignments`. The runner polls before fetching work and on its 60-second keepalive during execution. IDE clients must discover and call these tools; merely connecting or sending a heartbeat does not post a reply.

Acknowledgements are standalone “I'm online.” messages attributed to the authenticated agent. Live project grants and membership are checked; retries and concurrent acknowledgements reuse the existing unique agent operation key. No acknowledgement is created from cached presence. The roster groups agents into Online, Stale, and Offline; inactive grants appear under Offline.

## Verification

The integration suite uses a separate empty PostgreSQL database and a mocked model. It covers human-message exclusion from agent reads and model context, operation replay, one saved plan per exchange, agent authority restrictions, and revocation during generation. Browser coverage checks sending a human message and opening connection onboarding on desktop and mobile.
