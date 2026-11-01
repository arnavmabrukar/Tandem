import psycopg

from mediator.config import settings

def get_or_create_user(
        issuer: str,
        subject: str,
        name: str,
) -> dict[str,str]:
    # find or create a tandem user using their verification auth0 identity


    if not issuer.strip() or not subject.strip() or not name.strip():
        raise ValueError("User identitiy and name must not be empty")

    # refuse to connect w/o and explicity configured DB url
    if settings.database_url is None:
        raise RuntimeError("DATABASE_URL is not configured")

    # extract the actual value only after starting the connection 
    database_url = settings.database_url.get_secret_value()

    if not database_url.strip():
        raise RuntimeError("DATABASE_URL is empty")

    # on successful exit, this block commits the transaction.
    # on failure, it rolls back. either way, it closes the connection
    with psycopg.connect(database_url, connect_timeout=10) as connection:
        cursor = connection.execute(
            """
            INSERT INTO public.users (auth_issuer, auth_subject, name)
            VALUES (%s, %s, %s)

            -- If this identity already exists, keep its existing ID.
            -- For now, synchronize the display name from Auth0.
            ON CONFLICT (auth_issuer, auth_subject)
            DO UPDATE SET name = EXCLUDED.name

            -- Return the saved user's fields for the dashboard.
            RETURNING id, name
            """,
            # Pass values separately from SQL to prevent SQL injection.
            (issuer, subject, name.strip()),
        )

        # returning produces one row, represented as a python tuple
        row = cursor.fetchone()

        if row is None:
            raise RuntimeError("Saving the user returned no row")

    # this runs after the transaction has successfully committed.
    # convert postrgreSQL uuid object into a JSON-compatible string
    return {"id":str(row[0]),"name":row[1]}
    