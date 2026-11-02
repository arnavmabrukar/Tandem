BEGIN;

-- Public desktop clients use PKCE, never a shared client secret.
CREATE TABLE public.mcp_oauth_clients (
    id TEXT PRIMARY KEY,
    metadata JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Browser consent tickets and authorization codes are short-lived, single-use.
-- Only hashes of their random secrets are stored.
CREATE TABLE public.mcp_oauth_requests (
    ticket_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES public.mcp_oauth_clients(id),
    params JSONB NOT NULL,
    owner_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '10 minutes'
);
CREATE TABLE public.mcp_oauth_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id TEXT NOT NULL REFERENCES public.mcp_oauth_clients(id),
    owner_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    project_id UUID NOT NULL,
    agent_id TEXT NOT NULL,
    resource TEXT NOT NULL,
    revoked BOOLEAN NOT NULL DEFAULT FALSE,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 days',
    FOREIGN KEY (project_id, agent_id)
        REFERENCES public.agent_project_grants(project_id, agent_id) ON DELETE CASCADE
);
CREATE TABLE public.mcp_oauth_codes (
    code_hash TEXT PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES public.mcp_oauth_sessions(id) ON DELETE CASCADE,
    params JSONB NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '2 minutes'
);
CREATE TABLE public.mcp_oauth_tokens (
    token_hash TEXT PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES public.mcp_oauth_sessions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    used BOOLEAN NOT NULL DEFAULT FALSE,
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX mcp_oauth_tokens_session_idx ON public.mcp_oauth_tokens(session_id);
CREATE INDEX mcp_oauth_requests_expiry_idx ON public.mcp_oauth_requests(expires_at);
CREATE INDEX mcp_oauth_codes_expiry_idx ON public.mcp_oauth_codes(expires_at);
COMMIT;
