"""Durable worker controls, separate from deletable chat history."""
from uuid import UUID, uuid4, uuid5
from psycopg.types.json import Jsonb
from mediator.db.agent_tasks import _transaction, AgentOperationConflict


def latest_control(conn, project_id, agent_id):
    row = conn.execute("""SELECT operation_id::text AS id, request_payload->>'action' AS action
        FROM public.operations WHERE operation_type='room_worker_control'
          AND request_payload->>'projectId'=%s AND request_payload->>'agentId'=%s
        ORDER BY created_at DESC, operation_id DESC LIMIT 1""",
        (str(project_id), str(agent_id))).fetchone()
    return row


def save_controls(conn, project_id, user_id, operation_id, action, agents):
    # Revalidate and lock grants before acquiring the project lock, matching
    # agent mutations. Revoked connections cannot receive new commands.
    eligible = conn.execute("""SELECT a.id::text AS id FROM public.agents a
        JOIN public.agent_project_grants g ON g.agent_id=a.id AND g.owner_user_id=a.owner_user_id
        JOIN public.project_memberships m ON m.project_id=g.project_id AND m.user_id=a.owner_user_id
        WHERE g.project_id=%s AND a.id=ANY(%s::text[]) AND g.status='active'
          AND a.grant_status='active' AND m.role IN ('owner','reviewer')
        ORDER BY a.id FOR SHARE OF a,g,m""", (project_id, [str(agent['id']) for agent in agents])).fetchall()
    if {row['id'] for row in eligible} != {str(agent['id']) for agent in agents}:
        raise AgentOperationConflict('Agent access changed; refresh before sending the command')
    # Serialize commands with claims, so a stop that commits first blocks a claim.
    conn.execute('SELECT id FROM public.projects WHERE id=%s FOR UPDATE', (project_id,))
    for agent in agents:
        payload = {'projectId': str(project_id), 'agentId': str(agent['id']), 'action': action}
        conn.execute("""INSERT INTO public.operations
            (actor_id,operation_id,operation_type,request_payload,response_payload,created_at)
            VALUES (%s,%s,'room_worker_control',%s,%s,clock_timestamp())
            ON CONFLICT (actor_id,operation_id) DO NOTHING""",
            (user_id, uuid5(operation_id, f"control:{agent['id']}"), Jsonb(payload), Jsonb({'queued': True})))


def acknowledge_control(project_id: UUID, control_id: UUID, identity):
    from mediator.db.room import _authorize, _public
    with _transaction() as conn:
        _, _, name = _authorize(conn, project_id, identity=identity, write=True)
        control = latest_control(conn, project_id, identity['agentId'])
        if not control or control['id'] != str(control_id):
            raise AgentOperationConflict('Worker control was replaced or is unavailable')
        if control['action'] == 'stop':
            active = conn.execute("""SELECT 1 FROM public.tasks WHERE project_id=%s
                AND claimed_by_agent_id=%s AND status IN ('claimed','in_progress') LIMIT 1""",
                (project_id, identity['agentId'])).fetchone()
            if active:
                # Only the agent's authenticated acknowledgement after finishing
                # may say it is idle. A heartbeat or queued command cannot.
                return {'acknowledged': False, 'finishingCurrentTask': True}
        body = ("I'm idle. I won't claim new tasks until /start."
                if control['action'] == 'stop' else "I'm ready to accept tasks again.")
        ack_id = uuid5(control_id, 'acknowledgement')
        conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',
                     (f"room:{project_id}:{identity['agentId']}",))
        existing = conn.execute("""SELECT * FROM public.agent_room_exchanges
            WHERE project_id=%s AND sender_agent_id=%s AND operation_id=%s""",
            (project_id, identity['agentId'], ack_id)).fetchone()
        if existing:
            if existing['body'] != body or existing['response'] is not None or existing['state'] != 'complete':
                raise AgentOperationConflict('Control acknowledgement operation ID is already in use')
            return {'acknowledged': True, 'exchange': _public(existing)}
        row = conn.execute("""INSERT INTO public.agent_room_exchanges
            (project_id,sender_agent_id,sender_name,operation_id,body,state,lease,lease_until,completed_at)
            VALUES (%s,%s,%s,%s,%s,'complete',%s,now(),now()) RETURNING *""",
            (project_id, identity['agentId'], name, ack_id, body, uuid4())).fetchone()
        return {'acknowledged': True, 'exchange': _public(row)}
