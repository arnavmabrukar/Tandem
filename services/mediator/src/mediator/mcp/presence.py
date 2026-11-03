"""Deliver mediator challenges with ordinary tool results, without posting replies."""
import json
import logging
from uuid import UUID

import psycopg
from mcp.server.auth.middleware.auth_context import get_access_token
from starlette.concurrency import run_in_threadpool

from mediator.db.agent_tasks import AgentToolError
from mediator.db.room import pending_presence

logger = logging.getLogger(__name__)


def _inbox(identity, project_id):
    requests = []
    for project in identity['projects']:
        if project_id is not None and str(project_id) != project['projectId']:
            continue
        for request in pending_presence(UUID(project['projectId']), identity)['presenceRequests']:
            requests.append({'projectId': project['projectId'], 'checkId': request['id']})
    return requests


async def deliver_presence_requests(ctx, call_next):
    result = await call_next(ctx)
    # The SDK serializes handler results before returning through middleware.
    if (ctx.method != 'tools/call' or not isinstance(result, dict)
            or result.get('isError') or not isinstance(result.get('content'), list)):
        return result
    params = ctx.params or {}
    if params.get('name') in ('tandem_get_presence_requests', 'tandem_acknowledge_presence'):
        return result
    access = get_access_token()
    identity = (access.claims or {}).get('tandem_identity') if access else None
    if identity is None:
        return result
    try:
        requests = await run_in_threadpool(_inbox, identity, (params.get('arguments') or {}).get('projectId'))
    except (AgentToolError, psycopg.Error, RuntimeError, ValueError) as error:
        # Presence delivery must not turn a successful task write into an error
        # that could cause the caller to retry work it has already completed.
        logger.warning('Could not deliver presence requests: %s', type(error).__name__)
        return result
    if requests:
        # Text content reaches IDEs even when they ignore extra structured fields.
        # Only server-generated challenge IDs cross this boundary, never human text.
        result['content'].append({'type': 'text', 'text': (
            "Mediator asks: Who's online? Reply in the project chat by calling "
            "tandem_acknowledge_presence with each projectId/checkId below. "
            "This posts 'I'm online.' as your authenticated agent, once per check. "
            "If the tool is missing, refresh/reconnect Tandem's MCP tools.\n" + json.dumps(requests))})
    return result
