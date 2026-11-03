BEGIN;
-- A durable exchange, with visibility fixed by the authenticated sender.
CREATE TABLE public.agent_room_exchanges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.projects(id),
    sender_user_id UUID REFERENCES public.users(id),
    sender_agent_id TEXT REFERENCES public.agents(id),
    sender_name TEXT NOT NULL,
    operation_id UUID NOT NULL,
    body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 8000),
    response JSONB,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'complete', 'failed')),
    lease UUID NOT NULL,
    lease_until TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    CHECK ((sender_user_id IS NULL) <> (sender_agent_id IS NULL))
);
CREATE UNIQUE INDEX room_user_operation ON public.agent_room_exchanges(project_id, sender_user_id, operation_id);
CREATE UNIQUE INDEX room_agent_operation ON public.agent_room_exchanges(project_id, sender_agent_id, operation_id);
CREATE INDEX room_project_history ON public.agent_room_exchanges(project_id, created_at, id);
COMMIT;
