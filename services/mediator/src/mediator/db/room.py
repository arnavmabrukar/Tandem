"""Project room: agents can never read human exchanges, even through model context."""
import re
from uuid import UUID, uuid4
from psycopg.types.json import Jsonb
from mediator.config import settings
from mediator.db.agent_tasks import _transaction, _current_role, AgentAccessDenied, AgentOperationConflict
from mediator.meta_planner import generate_plan
from mediator.schemas.plans import PlanChatRequest
from mediator.schemas.room import RoomMessageRequest, RoomReply


def _authorize(conn, project_id, *, user_id=None, identity=None, write=False, lock_project=True):
    # Also serialize final publication with project disconnection.
    project = conn.execute("SELECT name, repository, version FROM public.projects WHERE id=%s AND disconnected_at IS NULL"
                           + (' FOR SHARE' if lock_project else ''), (project_id,)).fetchone()
    if not project:
        raise AgentAccessDenied("Project is unavailable")
    if identity is not None:
        if str(project_id) not in {str(p['projectId']) for p in identity['projects']}:
            raise AgentAccessDenied("Connection does not cover this project")
        role = _current_role(conn, identity, project_id)
        sender = conn.execute("SELECT name FROM public.agents WHERE id=%s", (identity['agentId'],)).fetchone()
    else:
        membership = conn.execute("SELECT role FROM public.project_memberships WHERE project_id=%s AND user_id=%s FOR SHARE", (project_id, user_id)).fetchone()
        if not membership:
            raise AgentAccessDenied("Project membership required")
        role = membership['role']
        sender = conn.execute("SELECT name FROM public.users WHERE id=%s", (user_id,)).fetchone()
    if write and role not in ('owner', 'reviewer'):
        raise AgentAccessDenied("Your role can read this room but cannot post")
    return project, role, sender['name']


def _history(conn, project_id, agent=False, limit=100):
    # Filter BEFORE limiting. Never expose private text, response, IDs, or counts.
    return conn.execute("""SELECT * FROM public.agent_room_exchanges
        WHERE project_id=%s AND (%s = false OR sender_agent_id IS NOT NULL)
        ORDER BY created_at DESC, id DESC LIMIT %s""", (project_id, agent, limit)).fetchall()[::-1]


def _public(row):
    return dict(id=str(row['id']), operationId=str(row['operation_id']), sender=row['sender_name'], senderUserId=str(row['sender_user_id']) if row['sender_user_id'] else None,
                senderAgentId=row['sender_agent_id'],
                kind='human' if row['sender_user_id'] else 'agent',
                body=row['body'], response=row['response'], state=row['state'],
                createdAt=row['created_at'].isoformat())


def pending_presence(project_id: UUID, identity):
    """Expose only mediator-generated challenges, never their source exchanges."""
    with _transaction() as conn:
        _authorize(conn, project_id, identity=identity)
        rows = conn.execute("""SELECT response->>'presenceCheckId' AS id
            FROM public.agent_room_exchanges r
            WHERE project_id=%s AND state='complete'
              AND completed_at > now()-interval '5 minutes'
              AND response->>'presenceCheckId' IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM public.agent_room_exchanges a
                  WHERE a.project_id=r.project_id AND a.sender_agent_id=%s
                    AND a.operation_id=(r.response->>'presenceCheckId')::uuid)
            ORDER BY completed_at, id""", (project_id, identity['agentId'])).fetchall()
        return {'presenceRequests': [{'id': r['id'], 'message': "Who's online?"} for r in rows]}


def acknowledge_presence(project_id: UUID, check_id: UUID, identity):
    with _transaction() as conn:
        # A presence acknowledgement is available to all connected roles, but
        # still requires a live grant and membership on every call.
        _, _, name = _authorize(conn, project_id, identity=identity)
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                     (f"room:{project_id}:{identity['agentId']}",))
        existing = conn.execute("""SELECT * FROM public.agent_room_exchanges
            WHERE project_id=%s AND sender_agent_id=%s AND operation_id=%s""",
            (project_id, identity['agentId'], check_id)).fetchone()
        if existing:
            if existing['response'] is not None or existing['state'] != 'complete':
                raise AgentOperationConflict('Presence operation ID is already in use')
            return _public(existing)
        check = conn.execute("""SELECT 1 FROM public.agent_room_exchanges
            WHERE project_id=%s AND state='complete'
              AND completed_at > now()-interval '5 minutes'
              AND response->>'presenceCheckId'=%s""", (project_id, str(check_id))).fetchone()
        if not check:
            raise AgentOperationConflict('Presence check is unavailable or expired')
        # NULL response + complete represents a standalone message. The request
        # UUID is also the operation UUID, enforcing one reply per agent/check.
        row = conn.execute("""INSERT INTO public.agent_room_exchanges
            (project_id,sender_agent_id,sender_name,operation_id,body,state,lease,lease_until,completed_at)
            VALUES (%s,%s,%s,%s,%s,'complete',%s,now(),now()) RETURNING *""",
            (project_id, identity['agentId'], name, check_id, "I'm online.", uuid4())).fetchone()
        return _public(row)


def pending_worker_requests(project_id: UUID, identity, task_id: UUID | None = None):
    with _transaction() as conn:
        _authorize(conn, project_id, identity=identity)
        rows = conn.execute("""SELECT r.body, r.response->'workerRequest' AS request
            FROM public.agent_room_exchanges r
            WHERE r.project_id=%s AND r.state='complete'
              AND r.response->'workerRequest'->>'agentId'=%s
              AND (%s::text IS NULL OR r.response->'workerRequest'->>'taskId'=%s::text)
              AND NOT EXISTS (SELECT 1 FROM public.agent_room_exchanges a
                  WHERE a.project_id=r.project_id AND a.sender_agent_id=%s
                    AND a.operation_id=(r.response->'workerRequest'->>'id')::uuid)
            ORDER BY r.created_at, r.id LIMIT 10""",
            (project_id, identity['agentId'], task_id, task_id, identity['agentId'])).fetchall()
        # Older requests explicitly shared their human text; new requests carry
        # only mediator-written text in the workerRequest payload.
        return {'workerRequests': [{'id': row['request']['id'], 'taskId': row['request']['taskId'],
                                    'message': row['request'].get('message', row['body'])} for row in rows]}


def reply_worker_request(project_id: UUID, request_id: UUID, body: str, identity):
    if len(body.strip()) > 8000:
        raise AgentOperationConflict('Worker room replies must be at most 8000 characters')
    with _transaction() as conn:
        _, _, name = _authorize(conn, project_id, identity=identity)
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                     (f'room:{project_id}:{identity["agentId"]}',))
        existing = conn.execute("""SELECT * FROM public.agent_room_exchanges
            WHERE project_id=%s AND sender_agent_id=%s AND operation_id=%s""",
            (project_id, identity['agentId'], request_id)).fetchone()
        if existing:
            if existing['body'] != body:
                raise AgentOperationConflict('This worker request already has a different reply')
            return _public(existing)
        request = conn.execute("""SELECT 1 FROM public.agent_room_exchanges
            WHERE project_id=%s AND state='complete' AND sender_user_id IS NOT NULL
              AND response->'workerRequest'->>'id'=%s
              AND response->'workerRequest'->>'agentId'=%s""",
            (project_id, str(request_id), identity['agentId'])).fetchone()
        if not request:
            raise AgentOperationConflict('Worker request is unavailable or addressed to another agent')
        row = conn.execute("""INSERT INTO public.agent_room_exchanges
            (project_id,sender_agent_id,sender_name,operation_id,body,state,lease,lease_until,completed_at)
            VALUES (%s,%s,%s,%s,%s,'complete',%s,now(),now()) RETURNING *""",
            (project_id, identity['agentId'], name, request_id, body, uuid4())).fetchone()
        return _public(row)


def read_room(project_id: UUID, *, user_id=None, identity=None):
    with _transaction() as conn:
        _authorize(conn, project_id, user_id=user_id, identity=identity)
        rows = _history(conn, project_id, identity is not None)
        approvals = {str(r['plan_id']): r['plan_version'] for r in conn.execute(
            'SELECT plan_id, plan_version FROM public.plan_approvals WHERE project_id=%s', (project_id,)).fetchall()}
        for row in rows:
            saved = (row['response'] or {}).get('saved')
            if saved:
                saved['approvedPlanVersion'] = approvals.get(saved['planId'])
        return {'exchanges': [_public(row) for row in rows], 'mediatorModel': settings.meta_model}


def clear_room(project_id: UUID, through_id: UUID, user_id: UUID):
    """Delete shared history through the captured boundary; retain later messages."""
    with _transaction() as conn:
        # Deletion publishes nothing and does not update the project. Avoid a
        # project lock while waiting for room rows: saving a draft locks its room
        # row before updating the project. The membership lock still protects authority.
        _, role, _ = _authorize(conn, project_id, user_id=user_id, lock_project=False)
        if role != 'owner':
            raise AgentAccessDenied('Only the project owner can clear the room')
        # Use the same ordering as history. A retry whose boundary was already
        # deleted is a no-op, never a request to delete newly arrived messages.
        conn.execute("""WITH boundary AS (
                SELECT created_at, id FROM public.agent_room_exchanges
                WHERE project_id=%s AND id=%s
            )
            DELETE FROM public.agent_room_exchanges
            WHERE project_id=%s AND (created_at, id) <= (SELECT created_at, id FROM boundary)""",
            (project_id, through_id, project_id))
        # Saved plans, tasks and their approval records are independent of room
        # rows and remain intact. Pending model replies cannot recreate a row.
        return {'cleared': True}


def _context(conn, project_id, project, role, agent):
    tasks = conn.execute("""SELECT t.id::text, t.title, t.status, t.contract_summary AS scope,
        t.progress, t.claimed_by_agent_id::text AS agent_id, a.name AS agent_name
        FROM public.tasks t LEFT JOIN public.agents a ON a.id=t.claimed_by_agent_id
        WHERE t.project_id=%s ORDER BY t.updated_at DESC, t.id LIMIT 100""", (project_id,)).fetchall()
    return {**project, 'role': role, 'senderKind': 'agent' if agent else 'human',
            'tasks': tasks, 'taskLimit': 100}


def _mentioned_agent(body: str, tasks: list[dict]) -> tuple[str | None, str | None]:
    """Resolve exact @names from this project's working tasks, including spaces."""
    agents = {(str(task['agent_id']), task['agent_name']) for task in tasks
              if task.get('agent_id') and task.get('agent_name')
              and task['status'] in ('claimed', 'in_progress', 'blocked')}
    matches = set()
    for marker in re.finditer(r'(?<!\S)@', body):
        remaining = body[marker.end():]
        candidates = [(agent_id, name) for agent_id, name in agents
                      if remaining.casefold().startswith(name.casefold())
                      and (len(remaining) == len(name) or not re.match(r'[\w-]', remaining[len(name)]))]
        if not candidates:
            return None, 'I could not find that @agent on an active task in this project.'
        matches.add(max(candidates, key=lambda candidate: len(candidate[1]))[0])
    if len(matches) > 1:
        return None, 'Mention one working agent at a time.'
    return next(iter(matches), None), None


def _conversation(rows, current_id):
    messages = []
    # Bound model input without allowing pending parallel requests to masquerade as replies.
    for row in rows:
        if row['id'] == current_id:
            continue
        if row['state'] == 'complete':
            messages.append({'role': 'user', 'content': f"{row['sender_name']}: {row['body']}"[:8000]})
            if (row['response'] or {}).get('reply'):
                messages.append({'role': 'assistant', 'content': row['response']['reply'][:8000]})
    current = next(row for row in rows if row['id'] == current_id)
    messages = messages[-4:] + [{'role': 'user', 'content': current['body']}]
    # 4 * 8000 + 8000 meets the existing provider request cap.
    return PlanChatRequest(messages=messages)


def post_message(project_id: UUID, request: RoomMessageRequest, *, user_id=None, identity=None):
    agent_id = identity['agentId'] if identity is not None else None
    lease = uuid4()
    with _transaction() as conn:
        project, role, name = _authorize(conn, project_id, user_id=user_id, identity=identity, write=True)
        # Serialize this sender's submissions; duplicate operation IDs cannot race inserts.
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (f'room:{project_id}:{agent_id or user_id}',))
        row = conn.execute("""SELECT *, lease_until > now() AS busy FROM public.agent_room_exchanges
            WHERE project_id=%s AND operation_id=%s
              AND sender_user_id IS NOT DISTINCT FROM %s::uuid
              AND sender_agent_id IS NOT DISTINCT FROM %s::text FOR UPDATE""",
            (project_id, request.operationId, user_id, agent_id)).fetchone()
        if row:
            if row['body'] != request.body:
                raise AgentOperationConflict('Use a new operation ID for a different message')
            if row['state'] == 'complete':
                return _public(row)
            if row['state'] == 'pending' and row['busy']:
                raise AgentOperationConflict('The mediator is still replying; retry this operation shortly')
            conn.execute("UPDATE public.agent_room_exchanges SET state='pending', lease=%s, lease_until=now()+interval '3 minutes' WHERE id=%s", (lease, row['id']))
        else:
            if conn.execute("""SELECT 1 FROM public.agent_room_exchanges WHERE project_id=%s
                AND sender_user_id IS NOT DISTINCT FROM %s::uuid
                AND sender_agent_id IS NOT DISTINCT FROM %s::text
                AND state='pending' AND lease_until > now()""", (project_id, user_id, agent_id)).fetchone():
                raise AgentOperationConflict('Wait for your previous reply before sending another message')
            row = conn.execute("""INSERT INTO public.agent_room_exchanges
                (project_id,sender_user_id,sender_agent_id,sender_name,operation_id,body,lease,lease_until)
                VALUES (%s,%s,%s,%s,%s,%s,%s,now()+interval '3 minutes') RETURNING *""",
                (project_id, user_id, agent_id, name, request.operationId, request.body, lease)).fetchone()
        context = _context(conn, project_id, project, role, identity is not None)
        mention_id, mention_error = _mentioned_agent(request.body, context['tasks']) if identity is None else (None, None)
        if mention_id:
            context['mentionedAgentId'] = mention_id
        history = _history(conn, project_id, identity is not None, 10)
        if not any(r['id'] == row['id'] for r in history):
            history.append(row)
        conversation = _conversation(history, row['id'])
    try:
        # Never hold a transaction open while waiting for a model provider.
        reply = RoomReply.model_validate(generate_plan('', context, conversation=conversation, room=True))
        with _transaction() as conn:
            _, role, _ = _authorize(conn, project_id, user_id=user_id, identity=identity, write=True)
            if identity is not None or role != 'owner':
                reply.proposal = None
                reply.cancelTaskIds = []
            else:
                # Model output cannot introduce arbitrary task IDs or change active work.
                allowed = {str(t['id']) for t in context['tasks'] if t['status'] == 'open'}
                reply.cancelTaskIds = [i for i in reply.cancelTaskIds if str(i) in allowed]
            response = reply.model_dump(mode='json', exclude={'relayTaskId', 'relayMessage'})
            # Attribute replies to the configured model, never a name supplied
            # by the model itself. Persist it so future config changes keep history accurate.
            response['model'] = settings.meta_model
            if reply.requestPresence:
                # Independent random ID: agents cannot infer the private source ID.
                response['presenceCheckId'] = str(uuid4())
            if mention_error:
                response['reply'] = mention_error
            elif identity is None and (reply.relayTaskId or reply.relayMessage or mention_id):
                relay_text = (reply.relayMessage or '').strip()
                if relay_text.casefold() == request.body.casefold() or '\x00' in relay_text:
                    # The model must compose a separate worker request, never
                    # forward the original private human message verbatim.
                    relay_text = ''
                mentioned_tasks = [task for task in context['tasks']
                                   if task['agent_id'] == mention_id
                                   and task['status'] in ('claimed', 'in_progress', 'blocked')]
                named_tasks = [task for task in mentioned_tasks
                               if task['title'].casefold() in request.body.casefold()]
                ambiguous_mention = bool(mention_id and len(mentioned_tasks) > 1 and len(named_tasks) != 1)
                relay_task_id = (UUID(mentioned_tasks[0]['id']) if mention_id and len(mentioned_tasks) == 1
                                 else UUID(named_tasks[0]['id']) if mention_id and len(named_tasks) == 1
                                 else reply.relayTaskId if not mention_id else None)
                target = conn.execute("""SELECT t.claimed_by_agent_id::text AS agent_id,
                        a.name AS agent_name, t.status
                    FROM public.tasks t JOIN public.agents a ON a.id=t.claimed_by_agent_id
                    JOIN public.agent_project_grants g ON g.agent_id=a.id AND g.project_id=t.project_id
                    WHERE t.project_id=%s AND t.id=%s
                      AND t.status IN ('claimed','in_progress','blocked')
                      AND a.grant_status='active' AND g.status='active'""",
                    (project_id, relay_task_id)).fetchone() if relay_task_id and relay_text else None
                if target and (not mention_id or target['agent_id'] == mention_id):
                    # Only the mediator-written payload reaches this worker's
                    # authenticated MCP request. The human exchange stays private.
                    response['workerRequest'] = {
                        'id': str(uuid4()), 'taskId': str(relay_task_id),
                        'agentId': target['agent_id'], 'message': relay_text,
                    }
                elif ambiguous_mention:
                    response['reply'] = 'That agent has multiple active tasks. Name the task in your message and ask again.'
                else:
                    response['reply'] = ('I could not relay that message. Choose a claimed, active, '
                                         'or blocked task with a connected agent and ask again.')
            updated = conn.execute("""UPDATE public.agent_room_exchanges
                SET response=%s,state='complete',completed_at=now()
                WHERE id=%s AND lease=%s RETURNING *""",
                (Jsonb(response), row['id'], lease)).fetchone()
            if not updated:
                raise AgentOperationConflict('A newer retry is handling this message')
            return _public(updated)
    except Exception:
        with _transaction() as conn:
            conn.execute("UPDATE public.agent_room_exchanges SET state='failed' WHERE id=%s AND lease=%s AND state='pending'", (row['id'], lease))
        raise


def save_draft(project_id: UUID, exchange_id: UUID, user_id: UUID):
    """Save one draft per exchange, including after a lost HTTP response."""
    from mediator.db.plans import create_plan, get_plan
    from mediator.schemas.plans import CreatePlanRequest
    with _transaction() as conn:
        _, role, _ = _authorize(conn, project_id, user_id=user_id)
        if role != 'owner':
            raise AgentAccessDenied('Only the project owner can save a plan')
    # Do not hold a project share lock while create_plan updates its version.
    with _transaction() as conn:
        row = conn.execute('SELECT * FROM public.agent_room_exchanges WHERE id=%s AND project_id=%s FOR UPDATE',
                           (exchange_id, project_id)).fetchone()
        if not row or row['sender_user_id'] != user_id or not (row['response'] or {}).get('proposal'):
            raise AgentAccessDenied('Only the author can save this proposal')
        old = conn.execute('SELECT request_payload FROM public.operations WHERE actor_id=%s AND operation_id=%s',
                           (user_id, exchange_id)).fetchone()
        if old:
            payload = old['request_payload']
            request = CreatePlanRequest(operationId=exchange_id, expectedVersion=payload['expectedVersion'], proposal=row['response']['proposal'])
        else:
            project = conn.execute('SELECT version FROM public.projects WHERE id=%s', (project_id,)).fetchone()
            request = CreatePlanRequest(operationId=exchange_id, expectedVersion=project['version'], proposal=row['response']['proposal'])
        result = create_plan(user_id, project_id, request)
        revision = get_plan(user_id, project_id, result.planId, result.planVersion)
        response = {**row['response'], 'saved': revision.model_dump(mode='json')}
        conn.execute('UPDATE public.agent_room_exchanges SET response=%s WHERE id=%s', (Jsonb(response), exchange_id))
        return revision
