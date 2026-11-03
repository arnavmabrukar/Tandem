BEGIN;

-- An IDE agent is a verified submitter; its underlying model is not verified.
ALTER TABLE public.plan_proposal_revisions
    ADD COLUMN submitted_by_agent_id TEXT REFERENCES public.agents(id) ON DELETE RESTRICT,
    DROP CONSTRAINT plan_proposal_revisions_source_check,
    DROP CONSTRAINT plan_proposal_revisions_check;

ALTER TABLE public.plan_proposal_revisions
    ADD CONSTRAINT plan_revision_source_check CHECK (source IN ('human', 'model', 'agent')),
    ADD CONSTRAINT plan_revision_provenance_check CHECK (
        (source = 'human' AND submitted_by_agent_id IS NULL
            AND model_provider IS NULL AND model_name IS NULL)
        OR (source = 'agent' AND submitted_by_agent_id IS NOT NULL
            AND model_provider IS NULL AND model_name IS NULL)
        OR (source = 'model' AND submitted_by_agent_id IS NULL
            AND model_provider IS NOT NULL AND length(trim(model_provider)) > 0
            AND model_name IS NOT NULL AND length(trim(model_name)) > 0)
    ),
    -- created_by is the accountable human who owns the submitting agent.
    ADD CONSTRAINT plan_revision_agent_owner_fk
        FOREIGN KEY (submitted_by_agent_id, created_by)
        REFERENCES public.agents(id, owner_user_id) ON DELETE RESTRICT;

COMMIT;
