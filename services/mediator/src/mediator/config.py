from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

# Find the repository root from this file, regardless of the terminal directory.
REPO_ROOT = Path(__file__).resolve().parents[4]

class Settings(BaseSettings):
    app_name: str = "Tandem Mediator"

    # Neon supplies DATABASE_URL, without our usual TANDEM_ prefix.
    # SecretStr hides the password if the settings object is printed.
    database_url: SecretStr | None = Field(default=None, validation_alias="DATABASE_URL")

    model_config = SettingsConfigDict(
        env_prefix="TANDEM_",
        # Neon writes .env.local, or .env if it already exists.
        # Real environment variables take precedence over either file.
        env_file=(REPO_ROOT / ".env", REPO_ROOT / ".env.local"),
        env_file_encoding="utf-8",
        extra="ignore", # Neon may include settings this backend does not use yet.
    )

    # using regex to map possible hostnames, without https:// or a slash
    # our existing TANDEM_ prefix maps this to TANDEM_AUTH0_DOMAIN
    auth0_domain: str = Field(
        min_length=1,
        pattern=r"^[A-Za-z0-9.-]+$",
    )

    # must match the Auth0 api indentifier
    auth0_audience: str = Field(min_length=1)

    # cross browser origins allowed to call the backend
    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://agentictandem.vercel.app",
    ]

settings = Settings()
