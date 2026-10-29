# class used to create web app
from fastapi import FastAPI

# import settings object
from mediator.config import settings

app = FastAPI(title=settings.app_name)

@app.get("/health")
def health() -> dict[str, str]:
    return {"status":"ok"}