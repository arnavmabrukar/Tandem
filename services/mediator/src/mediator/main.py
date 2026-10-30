# class used to create web app
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from mediator.auth import require_access_token
from psycopg import Error as DatabaseError

# import settings object
from mediator.config import settings
from mediator.db.connection import check_database

app = FastAPI(title=settings.app_name)

# permit browser requests form the origins listen in config.py
app.add_middleware(
    CORSMiddleware,
    allow_origin=settings.cors_origins,

    # we use bearer tokens rather than cross-site cookies
    allow_credentials=False,

    # HTTP methods used by our dashboard
    allow_methods = ["GET", "POST", "PATCH", "OPTIONS"],

    # headers the frontend may send 
    allow_headers=["Authorization", "Content-Type", "Idempotency-Key"],
)

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

# These routes are placeholders until we implement authentication and storage.
# HTTP 501 explicitly tells the caller that the feature isn't implemented yet.

@app.get("/api/me", dependencies=[Depends(require_access_token)])
def get_current_user():
    raise HTTPException(
        status_code=501,
        detail="User lookup not implemented",
    )

@app.get("/api/workspace", dependencies=[Depends(require_access_token)])
def get_workspace():
    raise HTTPException(
        status_code=501,
        detail="Workspace lookup not implemented",
    )

@app.post("/api/projects", dependencies=[Depends(require_access_token)])
def create_project():
    raise HTTPException(
        status_code=501,
        detail="Project creation not implemented",
    )