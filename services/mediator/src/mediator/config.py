from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    app_name: str = "Tandem Mediator"
    model_config = SettingsConfigDict(env_prefix="TANDEM_")
settings = Settings()