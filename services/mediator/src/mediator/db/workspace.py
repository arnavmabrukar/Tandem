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

                                -- Tasks are currently unassigned.
                                'agentId', NULL,

                                -- Use the task ID as its stable thread key.
                                -- Message storage will be implemented separately.
                                'threadId', task.id::text,

                                -- No agent has received or accepted this task yet.
                                'receipt', 'pending',
                                'acceptance', 'pending',

                                -- Dependency storage is not implemented yet.
                                'dependencies', '[]'::jsonb,

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
                ) AS tasks

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

    # These features have no storage or working write endpoints yet.
    # Newly created projects therefore have no entries in these collections.
    # Replace these with database reads when implementing each feature.
    for project in projects:
        project.update({
            "agents": [],
            "approvals": [],
            "messages": [],
            "claims": [],
            "activity": [],
        })

    # An empty projects list now means the query found no memberships.
    # A database failure raises an exception instead of returning success.
    return {
        "schemaVersion": 1,
        "projects": projects,
    }