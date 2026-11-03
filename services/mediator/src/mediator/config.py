from pathlib import Path

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Find the repository root from this file, regardless of the terminal directory.
REPO_ROOT = Path(__file__).resolve().parents[4]

class Settings(BaseSettings):
    app_name: str = "Tandem Mediator"
    # Operational kill switch; individual projects still opt in explicitly.
    dispatch_enabled: bool = True

    # Meta credentials stay on the backend, never in VITE_* variables.
    model_api_key: SecretStr | None = Field(default=None, validation_alias="MODEL_API_KEY")
    meta_model: str = "muse-spark-1.3-contributor"

    # GitHub App OAuth: backend-only credentials and a Fernet encryption key.
    github_client_id: str = ""
    github_client_secret: SecretStr | None = None
    github_token_key: SecretStr | None = None
    github_app_slug: str = Field(default="", pattern=r"^[a-zA-Z0-9-]*$")
    github_callback_origin: str = "https://tandem-jr3e.onrender.com"
    github_dashboard_origin: str = "https://agentictandem.vercel.app"

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

    # Enable only after migration 011 and the consent page have been deployed.
    mcp_oauth_enabled: bool = False
    mcp_oauth_issuer: str = "https://tandem-jr3e.onrender.com"
    mcp_oauth_dashboard: str = "https://agentictandem.vercel.app"

    @field_validator("mcp_oauth_issuer", "mcp_oauth_dashboard", "github_callback_origin", "github_dashboard_origin")
    @classmethod
    def validate_oauth_origin(cls, value: str) -> str:
        from urllib.parse import urlsplit
        parsed = urlsplit(value)
        if (not parsed.hostname or parsed.username or parsed.password or parsed.query
            or parsed.fragment or parsed.path not in ("", "/")
            or not (parsed.scheme == "https" or (parsed.scheme == "http"
                and parsed.hostname in ("localhost", "127.0.0.1", "::1")))):
            raise ValueError("Use an HTTPS origin, or HTTP loopback for local development")
        return value.rstrip("/")

    # cross browser origins allowed to call the backend
    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://agentictandem.vercel.app",
    ]

settings = Settings()
