-- Proposals are separate from live tasks. This migration starts no agent work.
BEGIN;

CREATE TABLE public.plan_proposals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
    created_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (project_id, id)
);

-- Insert a new revision for each edit; retain older content for review history.
-- The future service must serialize revisions by locking the parent proposal.
CREATE TABLE public.plan_proposal_revisions (
    project_id UUID NOT NULL,
    plan_id UUID NOT NULL,
    version BIGINT NOT NULL CHECK (version >= 1),
    project_version BIGINT NOT NULL CHECK (project_version >= 1),
    created_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

    -- The API validates this JSON with PlanProposal, including the entire DAG.
    -- SQL checks the outer structure; it does not replace Python validation.
    proposal JSONB NOT NULL CHECK (
        jsonb_typeof(proposal) = 'object'
        AND proposal ?& ARRAY['goal', 'summary', 'tasks']
        AND jsonb_typeof(proposal->'goal') = 'string'
        AND jsonb_typeof(proposal->'summary') = 'string'
        AND jsonb_typeof(proposal->'tasks') = 'array'
    ),

    -- Provenance is supplied by our backend, never trusted from model output.
    source TEXT NOT NULL CHECK (source IN ('human', 'model')),
    model_provider TEXT,
    model_name TEXT,
    CHECK (
        (source = 'human' AND model_provider IS NULL AND model_name IS NULL)
        OR (source = 'model'
            AND model_provider IS NOT NULL AND length(trim(model_provider)) > 0
            AND model_name IS NOT NULL AND length(trim(model_name)) > 0)
    ),

    PRIMARY KEY (plan_id, version),
    FOREIGN KEY (project_id, plan_id)
        REFERENCES public.plan_proposals(project_id, id) ON DELETE RESTRICT
);

CREATE INDEX plan_proposals_project_created_idx
    ON public.plan_proposals(project_id, created_at, id);

-- Approval/materialization will be added with its service transaction later.
-- No approval state is inferred merely from a proposal being saved.
COMMIT;
