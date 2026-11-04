"""GitHub App user authorization and verified repository selection.

Only the intersection of the user's access and installed App permissions is used.
No GitHub tokens are returned to the browser. Expired tokens require reconnecting.
"""
import base64
import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import quote, urlencode
from uuid import UUID

import httpx
from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException

from mediator.config import settings
from mediator.db.agent_tasks import _transaction


def configured() -> bool:
    return bool(settings.github_client_id and settings.github_client_secret
                and settings.github_token_key and settings.github_app_slug)


def cipher() -> Fernet:
    if not configured():
        raise HTTPException(503, "GitHub connection is not configured on this backend")
    try:
        return Fernet(settings.github_token_key.get_secret_value().encode())
    except ValueError:
        raise HTTPException(503, "GitHub connection configuration is invalid") from None


def callback_url() -> str:
    return settings.github_callback_origin + "/api/github/callback"


def start(user_id: UUID) -> dict:
    cipher()
    state, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    with _transaction() as db:
        db.execute("DELETE FROM public.github_oauth_states WHERE expires_at < now() OR user_id=%s", (user_id,))
        db.execute("INSERT INTO public.github_oauth_states(state_hash,user_id,verifier) VALUES (%s,%s,%s)",
                   (hashlib.sha256(state.encode()).hexdigest(), user_id, verifier))
    return {"url": "https://github.com/login/oauth/authorize?" + urlencode({
        "client_id": settings.github_client_id, "redirect_uri": callback_url(),
        "state": state, "code_challenge": challenge, "code_challenge_method": "S256",
    })}


def api(token: str, path: str, not_found: str | None = None):
    # Paths are constructed by this module; never follow arbitrary pagination URLs.
    try:
        with httpx.Client(timeout=20, follow_redirects=False) as client:
            response = client.get("https://api.github.com" + path, headers={
                "Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            })
        if response.status_code == 401:
            raise HTTPException(403, "Reconnect GitHub; your authorization expired or was revoked")
        # Only for lookups made after access is confirmed, when a 404 means the thing is absent.
        if response.status_code == 404 and not_found:
            raise HTTPException(409, not_found)
        if response.status_code in (403, 404):
            raise HTTPException(403, "GitHub access unavailable. Check repository access and API rate limits")
        response.raise_for_status()
        return response.json()
    except (httpx.HTTPError, ValueError):
        raise HTTPException(502, "GitHub is unavailable; try again later") from None


def finish(user_id: UUID, code: str, state: str) -> dict:
    encryption = cipher()
    # Consume only a state belonging to this signed-in Tandem user.
    with _transaction() as db:
        saved = db.execute("""DELETE FROM public.github_oauth_states
            WHERE state_hash=%s AND user_id=%s AND expires_at>now() RETURNING verifier""",
            (hashlib.sha256(state.encode()).hexdigest(), user_id)).fetchone()
    if saved is None:
        raise HTTPException(400, "GitHub connection expired; start a new connection")
    try:
        with httpx.Client(timeout=20, follow_redirects=False) as client:
            response = client.post("https://github.com/login/oauth/access_token", headers={"Accept": "application/json"}, json={
                "client_id": settings.github_client_id,
                "client_secret": settings.github_client_secret.get_secret_value(),
                "code": code, "code_verifier": saved["verifier"], "redirect_uri": callback_url(),
            })
        response.raise_for_status()
        data = response.json()
        token = data["access_token"]
        if not isinstance(token, str) or not token.startswith("ghu_"):
            raise ValueError("Expected GitHub App user token")
        expires = datetime.now(timezone.utc) + timedelta(seconds=int(data.get("expires_in", 28800)))
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        raise HTTPException(502, "GitHub authorization failed; start a new connection") from None
    profile = api(token, "/user")
    with _transaction() as db:
        db.execute("""INSERT INTO public.github_connections(user_id,github_user_id,login,token_encrypted,expires_at)
            VALUES (%s,%s,%s,%s,%s) ON CONFLICT(user_id) DO UPDATE
            SET github_user_id=excluded.github_user_id,login=excluded.login,
                token_encrypted=excluded.token_encrypted,expires_at=excluded.expires_at,updated_at=now()""",
            (user_id, profile["id"], profile["login"], encryption.encrypt(token.encode()).decode(), expires))
    return {"login": profile["login"]}


def user_token(user_id: UUID) -> str:
    encryption = cipher()
    with _transaction() as db:
        row = db.execute("SELECT token_encrypted,expires_at FROM public.github_connections WHERE user_id=%s", (user_id,)).fetchone()
    if row is None or (row["expires_at"] and row["expires_at"] <= datetime.now(timezone.utc)):
        raise HTTPException(403, "Connect GitHub to select a repository")
    try:
        return encryption.decrypt(row["token_encrypted"].encode()).decode()
    except InvalidToken:
        raise HTTPException(403, "Reconnect GitHub to restore repository access") from None


def install_url() -> str:
    return f"https://github.com/apps/{settings.github_app_slug}/installations/new"


def connection(user_id: UUID) -> dict:
    # Reports the saved link only. A token revoked on GitHub surfaces on the next GitHub call.
    with _transaction() as db:
        row = db.execute("SELECT login,expires_at FROM public.github_connections WHERE user_id=%s", (user_id,)).fetchone()
    expired = row is not None and row["expires_at"] is not None and row["expires_at"] <= datetime.now(timezone.utc)
    return {"connected": row is not None and not expired, "login": row["login"] if row else None,
            "installUrl": install_url() if configured() else None}


def installations(user_id: UUID, page: int) -> dict:
    data = api(user_token(user_id), f"/user/installations?per_page=30&page={page}")
    return {"items": [{"id": i["id"], "name": i["account"]["login"]} for i in data["installations"]],
            "hasMore": page * 30 < data["total_count"],
            "installUrl": install_url()}


def repositories(user_id: UUID, installation_id: int, page: int) -> dict:
    data = api(user_token(user_id), f"/user/installations/{installation_id}/repositories?per_page=30&page={page}")
    return {"items": [{"id": i["id"], "name": i["name"], "fullName": i["full_name"],
                       "defaultBranch": i["default_branch"], "description": i.get("description") or ""}
                      for i in data["repositories"] if not i["archived"] and not i["disabled"]],
            "hasMore": page * 30 < data["total_count"]}


def verify_repository(user_id: UUID, installation_id: int, repository_id: int, branch: str) -> dict:
    token = user_token(user_id)
    # Stable numeric identity prevents a renamed/transferred repository being mistaken for another.
    repo = api(token, f"/repositories/{repository_id}")
    if repo.get("archived") or repo.get("disabled"):
        raise HTTPException(400, "Choose an active repository")
    # Verify the selected installation too, rather than trusting browser selection.
    page = 1
    while True:
        data = api(token, f"/user/installations/{installation_id}/repositories?per_page=100&page={page}")
        if any(i["id"] == repository_id for i in data["repositories"]):
            break
        if page * 100 >= data["total_count"]:
            raise HTTPException(403, "Repository is not accessible through this GitHub installation")
        page += 1
    full_name = repo["full_name"]
    api(token, f"/repos/{quote(full_name, safe='/')}/branches/{quote(branch, safe='')}",
        not_found=f"{full_name} has no branch named {branch}. "
                  "If the repository is empty, push a first commit and try again.")
    return repo
