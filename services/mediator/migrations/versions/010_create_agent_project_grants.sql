-- Add ownership and project access together, or roll back both on failure.
BEGIN;

ALTER TABLE public.agents
    -- The existing "owner" text is a display label, not trusted identity.
    -- Leave old agents unowned until a human explicitly registers/claims them.
    ADD COLUMN owner_user_id UUID
        REFERENCES public.users(id) ON DELETE RESTRICT,

    -- Required by the composite foreign key below. It prevents a grant from
    -- naming a different human than the agent's actual owner.
    ADD CONSTRAINT agents_id_owner_unique UNIQUE (id, owner_user_id);

-- New agents must be explicitly activated by the registration workflow.
-- Changing the default does not change existing agent records.
ALTER TABLE public.agents
    ALTER COLUMN grant_status SET DEFAULT 'pending';

CREATE INDEX agents_owner_user_idx ON public.agents (owner_user_id);

CREATE TABLE public.agent_project_grants (
    project_id UUID NOT NULL,
    agent_id TEXT NOT NULL,
    owner_user_id UUID NOT NULL,

    -- Project access and the agent's global grant_status are separate gates.
    -- Both must be active before a protected MCP tool may run.
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'active', 'revoked')),

    -- Record which authenticated human issued this grant.
    -- The backend must check that this person may grant project access.
    granted_by UUID NOT NULL
        REFERENCES public.users(id) ON DELETE RESTRICT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- One current grant per agent and project; revocation updates this row.
    PRIMARY KEY (project_id, agent_id),

    -- The NOT NULL owner field also prevents unowned legacy agents from
    -- receiving grants. Deleting an agent removes its grants.
    CONSTRAINT agent_project_grants_agent_owner_fk
        FOREIGN KEY (agent_id, owner_user_id)
        REFERENCES public.agents(id, owner_user_id)
        ON DELETE CASCADE,

    -- An agent's owner must belong to this project. Removing that membership
    -- removes the grant; joining again does not silently restore agent access.
    CONSTRAINT agent_project_grants_membership_fk
        FOREIGN KEY (project_id, owner_user_id)
        REFERENCES public.project_memberships(project_id, user_id)
        ON DELETE CASCADE
);

-- Support looking up the projects available to an authenticated agent.
CREATE INDEX agent_project_grants_agent_idx
    ON public.agent_project_grants (agent_id, status);

-- Support membership removal and grants belonging to a particular human.
CREATE INDEX agent_project_grants_owner_idx
    ON public.agent_project_grants (project_id, owner_user_id);

-- No grants are backfilled: existing agents gain no project access here.
-- Runtime authorization must also check the owner's CURRENT membership role
-- on every request. These foreign keys prove membership, not write permission.
-- Keep the existing token_hash column; never store raw agent tokens in it.
COMMIT;
