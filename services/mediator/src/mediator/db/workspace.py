import psycopg
from psycopg.rows import dict_row

from mediator.config import settings


def load_workspace(issuer: str, subject: str) -> dict:
    """Load only projects the verified Auth0 user belongs to."""

    # Require an explicit database connection.
    if settings.database_url is None:
        raise RuntimeError("DATABASE_URL is not configured")

    database_url = settings.database_url.get_secret_value()
    if not database_url.strip():
        raise RuntimeError("DATABASE_URL is empty")

    # dict_row gives us dictionaries instead of positional tuples.
    with psycopg.connect(
        database_url,
        connect_timeout=10,
        row_factory=dict_row,
    ) as connection:
        projects = connection.execute(
            """
            SELECT
                p.id::text AS id,
                p.name,
                p.repository,
                p.description,
                p.version,

                -- Collect all members of each authorized project.
                (
                    SELECT jsonb_agg(
                        jsonb_build_object(
                            'id', member_user.id::text,
                            'name', member_user.name,
                            'role', member.role
                        )
                        ORDER BY member_user.id
                    )
                    FROM public.project_memberships AS member
                    JOIN public.users AS member_user
                        ON member_user.id = member.user_id
                    WHERE member.project_id = p.id
                ) AS members,

                -- Read invitations belonging to this authorized project.
                -- COALESCE returns an empty JSON array when none exist.
                (
                    SELECT COALESCE(
                        jsonb_agg(
                            jsonb_build_object(
                                'id', invitation.id::text,
                                'email', invitation.email,
                                'role', invitation.role,
                                'status', invitation.status
                            )
                            ORDER BY invitation.created_at, invitation.id
                        ),
                        '[]'::jsonb
                    )
                    FROM public.project_invitations AS invitation
                    WHERE invitation.project_id = p.id

                      -- The current frontend supports these two statuses.
                      -- Accepted invitations become memberships and are
                      -- omitted from this invitation-management list.
                      AND invitation.status IN ('pending', 'revoked')
                ) AS invitations,

                -- Show only agents with a grant for this authorized project.
                -- Never expose token_hash or other credential material.
                (
                    SELECT COALESCE(
                        jsonb_agg(
                            jsonb_build_object(
                                'id', agent.id,
                                'name', agent.name,
                                'client', agent.client,
                                'owner', agent_owner.name,
                                'ownerId', agent_owner.id::text,
                                'machine', agent.machine,
                                'capabilities', agent.capabilities,

                                -- Both global and project access must be active.
                                -- Revocation takes precedence over pending.
                                'grant', CASE
                                    WHEN agent.grant_status = 'revoked'
                                      OR project_grant.status = 'revoked'
                                        THEN 'revoked'
                                    WHEN agent.grant_status = 'active'
                                      AND project_grant.status = 'active'
                                        THEN 'active'
                                    ELSE 'pending'
                                END,

                                -- A stored registration is not a live connection.
                                -- Inactive grants must not appear online.
                                -- Derived from the latest check-in so it expires
                                -- when an agent stops making requests.
                                'presence', CASE
                                    WHEN agent.grant_status <> 'active'
                                      OR project_grant.status <> 'active'
                                        THEN 'offline'
                                    WHEN agent.last_seen_at > now() - interval '2 minutes'
                                        THEN 'online'
                                    WHEN agent.last_seen_at > now() - interval '15 minutes'
                                        THEN 'stale'
                                    ELSE 'offline'
                                END,
                                'lastSeen', agent.last_seen_at,
                                'session', CASE
                                    WHEN agent.grant_status = 'active'
                                      AND project_grant.status = 'active'
                                        THEN agent.session
                                    ELSE NULL
                                END
                            )
                            ORDER BY project_grant.created_at, agent.id
                        ),
                        '[]'::jsonb
                    )
                    FROM public.agent_project_grants AS project_grant
                    JOIN public.agents AS agent
                        ON agent.id = project_grant.agent_id
                       AND agent.owner_user_id = project_grant.owner_user_id
                    JOIN public.users AS agent_owner
                        ON agent_owner.id = agent.owner_user_id
                    WHERE project_grant.project_id = p.id
                ) AS agents,

                -- Read tasks belonging to this authorized project.
                (
                    SELECT COALESCE(
                        jsonb_agg(
                            jsonb_build_object(
                                'id', task.id::text,
                                'title', task.title,
                                'description', task.description,
                                'status', task.status,
                                'version', task.version,
                                'progress', task.progress,

                                -- The agent holding the claim, if any.
                                'agentId', task.claimed_by_agent_id,

                                -- Use the task ID as its stable thread key.
                                -- Message storage will be implemented separately.
                                'threadId', task.id::text,

                                -- No agent has received or accepted this task yet.
                                'receipt', 'pending',
                                'acceptance', 'pending',

                                -- Return the prerequisite IDs saved for this task.
                                'dependencies', (
                                    SELECT COALESCE(
                                        jsonb_agg(
                                            -- The frontend expects string IDs.
                                            dependency.depends_on_task_id::text
                                            ORDER BY dependency.depends_on_task_id
                                        ),

                                        -- No prerequisites means an empty list.
                                        '[]'::jsonb
                                    )
                                    FROM public.task_dependencies AS dependency

                                    -- Read relationships for this task only,
                                    -- within its authorized project.
                                    WHERE dependency.project_id = task.project_id
                                      AND dependency.task_id = task.id
                                ),

                                -- Translate database columns into the nested
                                -- contract object expected by the frontend.
                                'contract', jsonb_build_object(
                                    'version', task.contract_version,
                                    'summary', task.contract_summary,
                                    'paths', task.contract_paths,
                                    'criteria', task.acceptance_criteria,

                                    -- No contract revisions are recorded yet.
                                    'history', '[]'::jsonb
                                ),

                                -- No agent result has been submitted.
                                'result', NULL
                            )
                            ORDER BY task.created_at, task.id
                        ),

                        -- Projects without tasks should return [] rather than null.
                        '[]'::jsonb
                    )
                    FROM public.tasks AS task

                    -- Keep each project's tasks scoped to that project.
                    WHERE task.project_id = p.id
                ) AS tasks,

                -- Load contract reviews only within this authorized project.
                (
                    SELECT COALESCE(
                        jsonb_agg(
                            jsonb_build_object(
                                'id', approval.id::text,
                                'taskId', approval.task_id::text,
                                'action', 'Approve contract',
                                'repository', approval.repository,

                                -- A pending request stops being actionable
                                -- when its target changes. Preserve completed
                                -- decisions as history of their original target.
                                'status', CASE
                                    WHEN approval.status = 'pending' AND (
                                        approval.repository <> p.repository
                                        OR approval.task_version <> reviewed_task.version
                                        OR approval.contract_version <> reviewed_task.contract_version
                                        OR reviewed_task.status <> 'open'
                                    ) THEN 'stale'
                                    ELSE approval.status
                                END,
                                'taskVersion', approval.task_version,
                                'contractVersion', approval.contract_version,

                                -- Contract reviews have no code commit target.
                                'head', NULL,
                                'requestedAt', approval.requested_at,
                                'decidedBy', approval.decided_by_name,
                                'decidedAt', approval.decided_at,

                                -- The frontend expects a string even before
                                -- a reviewer has supplied a decision note.
                                'note', COALESCE(approval.note, '')
                            )
                            ORDER BY approval.requested_at, approval.id
                        ),
                        '[]'::jsonb
                    )
                    FROM public.contract_approvals AS approval
                    JOIN public.tasks AS reviewed_task
                        ON reviewed_task.project_id = approval.project_id
                       AND reviewed_task.id = approval.task_id
                    WHERE approval.project_id = p.id
                ) AS approvals,

                -- Read events belonging to this authorized project.
                (
                    SELECT COALESCE(
                        jsonb_agg(
                            jsonb_build_object(
                                'id', event.id::text,
                                'sequence', event.sequence,

                                -- Project-level events may have no task.
                                'taskId', event.task_id::text,
                                'kind', event.kind,

                                -- Preserve the historical actor display name.
                                'actor', event.actor_name,
                                'text', event.text,

                                -- JSONB serializes the timestamp as a string.
                                'createdAt', event.created_at
                            )
                            -- The frontend reverses this for newest first.
                            ORDER BY event.sequence
                        ),
                        '[]'::jsonb
                    )
                    FROM public.project_activity AS event
                    WHERE event.project_id = p.id
                ) AS activity,

                -- Load human and agent messages for this authorized project.
                (
                    SELECT COALESCE(
                        jsonb_agg(
                            jsonb_build_object(
                                'id', message.id,
                                'taskId', message.task_id::text,
                                'sequence', message.sequence,

                                -- Use the name captured when the note was posted.
                                'sender', message.sender_name,
                                'type', message.type,
                                'body', message.body,
                                'createdAt', message.created_at,
                                'replyTo', message.reply_to_message_id,

                                -- Saving a note does not prove agent receipt.
                                'receipt', 'pending'
                            )
                            ORDER BY message.task_id, message.sequence
                        ),

                        -- Projects without notes return an empty array.
                        '[]'::jsonb
                    )
                    FROM public.messages AS message
                    WHERE message.project_id = p.id
                      AND message.task_id IS NOT NULL
                ) AS messages

            FROM public.projects AS p

            -- Find the caller's membership in each project.
            JOIN public.project_memberships AS membership
                ON membership.project_id = p.id

            -- Resolve their internal user from the verified identity.
            JOIN public.users AS caller
                ON caller.id = membership.user_id

            -- This filter enforces which projects the caller can see.
            WHERE caller.auth_issuer = %s
              AND caller.auth_subject = %s

            -- Keep the result order predictable.
            ORDER BY p.created_at, p.id
            """,
            # Pass identity values separately from the SQL.
            (issuer, subject),
        ).fetchall()

    # Agents and the other implemented collections come from the query above.
    # File claims still await their feature implementation.
    for project in projects:
        project.update({
            "claims": [],
        })

    # An empty projects list now means the query found no memberships.
    # A database failure raises an exception instead of returning success.
    return {
        "schemaVersion": 1,
        "projects": projects,
    }
