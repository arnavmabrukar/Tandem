import logging
from uuid import UUID

import psycopg
from psycopg import sql

from mediator.config import settings

logger = logging.getLogger(__name__)

# Strongest first. A merged person keeps the higher of their two roles in a project.
ROLE_ORDER = ("owner", "reviewer", "viewer")

# Auth0 prefixes each subject with the connection that issued it.
SIGN_IN_METHODS = {"auth0": "Email and password", "google-oauth2": "Google"}


def get_or_create_user(
    issuer: str,
    subject: str,
    name: str,
    email: str | None = None,
    verified_email: str | None = None,
) -> dict:
    """Find or create the Tandem user for a verified Auth0 sign-in.

    Sign-ins that share a verified email become one user. An unverified email never
    joins anything, because anyone can register an address they don't control.
    """
    if not issuer.strip() or not subject.strip() or not name.strip():
        raise ValueError("User identitiy and name must not be empty")

    # on successful exit, this block commits the transaction.
    # on failure, it rolls back. either way, it closes the connection
    with _connect() as connection:
        if verified_email:
            # Two sign-ins arriving at once must not each create a separate user.
            connection.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (verified_email,)
            )

        user_id = _resolve_user_id(connection, issuer, subject, name, verified_email)
        connection.execute(
            """
            UPDATE public.user_identities SET verified_email = %s
            WHERE auth_issuer = %s AND auth_subject = %s
            """,
            (verified_email, issuer, subject),
        )
        if verified_email:
            user_id = _merge_duplicates(connection, user_id, verified_email)

        saved_name = _sync_name(connection, user_id, name.strip())
        identities = connection.execute(
            """
            SELECT auth_issuer, auth_subject FROM public.user_identities
            WHERE user_id = %s ORDER BY created_at, auth_subject
            """,
            (user_id,),
        ).fetchall()

    # this runs after the transaction has successfully committed.
    return {
        "id": str(user_id),
        "name": saved_name,
        "email": email,
        "emailVerified": verified_email is not None,
        "signIns": [
            {
                "method": _sign_in_method(row[1]),
                "current": row[0] == issuer and row[1] == subject,
            }
            for row in identities
        ],
    }


def update_display_name(issuer: str, subject: str, name: str) -> dict[str, str] | None:
    """Save a name the person chose, which later sign-ins no longer overwrite."""
    with _connect() as connection:
        row = connection.execute(
            """
            UPDATE public.users AS person
            SET name = %s, name_customized = true
            FROM public.user_identities AS identity
            WHERE identity.user_id = person.id
              AND identity.auth_issuer = %s
              AND identity.auth_subject = %s
            RETURNING person.id, person.name
            """,
            (name, issuer, subject),
        ).fetchone()
    return {"id": str(row[0]), "name": row[1]} if row else None


def _connect() -> psycopg.Connection:
    # refuse to connect w/o and explicity configured DB url
    if settings.database_url is None:
        raise RuntimeError("DATABASE_URL is not configured")

    # extract the actual value only after starting the connection
    database_url = settings.database_url.get_secret_value()

    if not database_url.strip():
        raise RuntimeError("DATABASE_URL is empty")

    return psycopg.connect(database_url, connect_timeout=10)


def _sign_in_method(subject: str) -> str:
    return SIGN_IN_METHODS.get(subject.split("|", 1)[0], "Other sign-in")


def _resolve_user_id(
    connection: psycopg.Connection,
    issuer: str,
    subject: str,
    name: str,
    verified_email: str | None,
) -> UUID:
    row = connection.execute(
        "SELECT user_id FROM public.user_identities WHERE auth_issuer = %s AND auth_subject = %s",
        (issuer, subject),
    ).fetchone()
    if row:
        return row[0]

    # A new sign-in with a verified email joins the person who already has that email.
    if verified_email:
        row = connection.execute(
            """
            SELECT user_id FROM public.user_identities
            WHERE verified_email = %s ORDER BY created_at LIMIT 1
            """,
            (verified_email,),
        ).fetchone()
        if row:
            connection.execute(
                """
                INSERT INTO public.user_identities (auth_issuer, auth_subject, user_id)
                VALUES (%s, %s, %s)
                """,
                (issuer, subject, row[0]),
            )
            return row[0]

    # ON CONFLICT covers two first sign-ins racing; a trigger adds the identity.
    row = connection.execute(
        """
        INSERT INTO public.users (auth_issuer, auth_subject, name)
        VALUES (%s, %s, %s)
        ON CONFLICT (auth_issuer, auth_subject) DO UPDATE SET name = public.users.name
        RETURNING id
        """,
        # Pass values separately from SQL to prevent SQL injection.
        (issuer, subject, name.strip()),
    ).fetchone()
    if row is None:
        raise RuntimeError("Saving the user returned no row")
    return row[0]


def _merge_duplicates(
    connection: psycopg.Connection, user_id: UUID, verified_email: str
) -> UUID:
    """Merge existing users who share this verified email, keeping the oldest."""
    users = connection.execute(
        """
        SELECT DISTINCT person.id, person.created_at
        FROM public.user_identities AS identity
        JOIN public.users AS person ON person.id = identity.user_id
        WHERE identity.verified_email = %s
        ORDER BY person.created_at, person.id
        """,
        (verified_email,),
    ).fetchall()
    if len(users) < 2:
        return user_id

    kept = users[0][0]
    for duplicate, _ in users[1:]:
        try:
            # A savepoint, so a failed merge undoes itself and sign-in still works.
            with connection.transaction():
                _merge_user(connection, kept=kept, merged=duplicate)
        except psycopg.Error:
            # The accounts stay separate. Log IDs only, never the email.
            logger.exception("Could not merge user %s into %s", duplicate, kept)
            if duplicate == user_id:
                return user_id
        else:
            logger.info("Merged user %s into %s", duplicate, kept)
            if duplicate == user_id:
                user_id = kept
    return user_id


def _merge_user(connection: psycopg.Connection, kept: UUID, merged: UUID) -> None:
    """Move everything from one user to another, then delete the emptied user."""
    connection.execute(
        "SELECT id FROM public.users WHERE id = ANY(%s) ORDER BY id FOR UPDATE",
        ([kept, merged],),
    )
    deferred = """agent_project_grants_agent_owner_fk, agent_project_grants_membership_fk,
                  plan_revision_agent_owner_fk"""
    connection.execute(f"SET CONSTRAINTS {deferred} DEFERRED")

    # This column has no direct reference to users, so the loop below can't find it.
    # Move it first: removing a duplicate membership cascades to grants still using it.
    connection.execute(
        "UPDATE public.agent_project_grants SET owner_user_id = %s WHERE owner_user_id = %s",
        (kept, merged),
    )

    # In a project both accounts belong to, keep one membership with the higher role.
    connection.execute(
        """
        UPDATE public.project_memberships AS keep
        SET role = other.role
        FROM public.project_memberships AS other
        WHERE keep.user_id = %s AND other.user_id = %s
          AND keep.project_id = other.project_id
          AND array_position(%s::text[], other.role) < array_position(%s::text[], keep.role)
        """,
        (kept, merged, list(ROLE_ORDER), list(ROLE_ORDER)),
    )
    connection.execute(
        """
        DELETE FROM public.project_memberships AS other
        USING public.project_memberships AS keep
        WHERE other.user_id = %s AND keep.user_id = %s AND keep.project_id = other.project_id
        """,
        (merged, kept),
    )

    # A person has one GitHub connection, and the kept account's stays if it has one.
    connection.execute(
        """
        DELETE FROM public.github_connections AS other
        WHERE other.user_id = %s
          AND EXISTS (SELECT 1 FROM public.github_connections WHERE user_id = %s)
        """,
        (merged, kept),
    )

    # Both accounts may have imported the same repository, which one creator can't do.
    # Both projects stay. Clearing the creator only frees the merged account's copy from
    # the duplicate-import rule, which is the only thing this column is used for.
    connection.execute(
        """
        UPDATE public.projects AS other SET connected_by = NULL
        FROM public.projects AS keep
        WHERE other.connected_by = %s AND keep.connected_by = %s
          AND other.github_repository_id = keep.github_repository_id
          AND other.disconnected_at IS NULL AND keep.disconnected_at IS NULL
        """,
        (merged, kept),
    )

    # Ask the database for every reference, so a table added later can't be missed.
    references = connection.execute(
        """
        SELECT namespace.nspname, source.relname, attribute.attname
        FROM pg_constraint AS reference
        JOIN pg_class AS source ON source.oid = reference.conrelid
        JOIN pg_namespace AS namespace ON namespace.oid = source.relnamespace
        JOIN pg_attribute AS attribute
            ON attribute.attrelid = reference.conrelid
           AND attribute.attnum = reference.conkey[1]
        WHERE reference.contype = 'f'
          AND reference.confrelid = 'public.users'::regclass
          AND cardinality(reference.conkey) = 1
        """
    ).fetchall()
    for schema, table, column in references:
        connection.execute(
            sql.SQL("UPDATE {table} SET {column} = %s WHERE {column} = %s").format(
                table=sql.Identifier(schema, table), column=sql.Identifier(column)
            ),
            (kept, merged),
        )

    # A name the person chose beats one synced from Auth0.
    connection.execute(
        """
        UPDATE public.users AS keep
        SET name = other.name, name_customized = true
        FROM public.users AS other
        WHERE keep.id = %s AND other.id = %s
          AND other.name_customized AND NOT keep.name_customized
        """,
        (kept, merged),
    )

    # Fails if anything still refers to the merged user, undoing the whole merge.
    connection.execute("DELETE FROM public.users WHERE id = %s", (merged,))
    connection.execute(
        "INSERT INTO public.user_merges (kept_user_id, merged_user_id) VALUES (%s, %s)",
        (kept, merged),
    )

    # Check the deferred references now, while this merge can still be undone alone.
    connection.execute(f"SET CONSTRAINTS {deferred} IMMEDIATE")


def _sync_name(connection: psycopg.Connection, user_id: UUID, auth0_name: str) -> str:
    row = connection.execute(
        "SELECT name, name_customized FROM public.users WHERE id = %s", (user_id,)
    ).fetchone()
    if row is None:
        raise RuntimeError("Saved user was not found")
    current, customized = row

    # Password sign-ins report the email as the name. It must not replace a real name
    # each time someone with both sign-ins uses the password one.
    if customized or auth0_name == current or ("@" in auth0_name and "@" not in current):
        return current

    connection.execute("UPDATE public.users SET name = %s WHERE id = %s", (auth0_name, user_id))
    return auth0_name
