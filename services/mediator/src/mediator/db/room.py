"""Project room: agents can never read human exchanges, even through model context."""
from uuid import UUID, uuid4
from psycopg.types.json import Jsonb
from mediator.config import settings
from mediator.db.agent_tasks import _transaction, _current_role, AgentAccessDenied, AgentOperationConflict
from mediator.meta_planner import generate_plan
from mediator.schemas.plans import PlanChatRequest
from mediator.schemas.room import RoomMessageRequest, RoomReply


def _authorize(conn, project_id, *, user_id=None, identity=None, write=False):
    # Also serialize final publication with project disconnection.
    project = conn.execute("SELECT name, repository, version FROM public.projects WHERE id=%s AND disconnected_at IS NULL FOR SHARE", (project_id,)).fetchone()
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


def _context(conn, project_id, project, role, agent):
    tasks = conn.execute("""SELECT id::text, title, status, contract_summary AS scope,
        progress FROM public.tasks WHERE project_id=%s
        ORDER BY updated_at DESC, id LIMIT 100""", (project_id,)).fetchall()
    return {**project, 'role': role, 'senderKind': 'agent' if agent else 'human',
            'tasks': tasks, 'taskLimit': 100}


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
            response = reply.model_dump(mode='json')
            # Attribute replies to the configured model, never a name supplied
            # by the model itself. Persist it so future config changes keep history accurate.
            response['model'] = settings.meta_model
            if reply.requestPresence:
                # Independent random ID: agents cannot infer the private source ID.
                response['presenceCheckId'] = str(uuid4())
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
