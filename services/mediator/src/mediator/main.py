# class used to create web app
from fastapi import FastAPI, HTTPException
from psycopg import Error as DatabaseError

# import settings object
from mediator.config import settings
from mediator.db.connection import check_database

app = FastAPI(title=settings.app_name)

@app.get("/health")
def health() -> dict[str, str]:
    return {"status":"ok"}


# Liveness (/health) checks the process; readiness also checks PostgreSQL.
# A normal def runs in FastAPI's thread pool so this synchronous database
# call does not block the application's async event loop.
@app.get("/ready")
def ready() -> dict[str, str]:
    try:
        available = check_database()
    except DatabaseError:
        # Never expose database credentials or driver error details to clients.
        available = False
    if not available:
        raise HTTPException(status_code=503, detail="Database unavailable")
    return {"status": "ok", "database": "connected"}

@app.get("/api/me")
def get_current_user():
    raise HTTPException(status_code=501, details="User lookup not implemented")

@app.get("/api/workspace")
def get_workspace():
    rise HTTPException(status_code=501, details="Workspace lookup not implemented")

@app.post("/api/projects")
def create_project():
    raise HTTPException(status_code=501, details="Project creation not implemented")