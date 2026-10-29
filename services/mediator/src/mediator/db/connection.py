import psycopg

from mediator.config import settings


def check_database() -> bool:
    """Verify a real round trip to PostgreSQL without changing any data."""
    if settings.database_url is None or not settings.database_url.get_secret_value().strip():
        return False

    # Keep the SSL options supplied by Neon in DATABASE_URL.
    # The pooled Neon URL handles server-side connection pooling.
    # The context manager closes this client connection after the check.
    with psycopg.connect(
        settings.database_url.get_secret_value(), connect_timeout=10
    ) as connection:
        # SELECT 1 needs no tables: it proves the database can execute a query.
        return connection.execute("SELECT 1").fetchone() == (1,)
