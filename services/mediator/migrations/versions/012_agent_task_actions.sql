-- Let authenticated agents claim tasks and appear in project activity.
-- Every change is additive, so code from before this migration keeps working.
-- Apply this BEFORE deploying code that reads these columns.
BEGIN;

ALTER TABLE public.tasks
    -- Revoking an agent does not release its claim; deleting the agent does.
    ADD COLUMN claimed_by_agent_id TEXT
        REFERENCES public.agents(id) ON DELETE SET NULL,
    ADD COLUMN claimed_at TIMESTAMPTZ;

-- Support finding the work currently held by an agent.
CREATE INDEX tasks_claimed_by_agent_idx
    ON public.tasks (claimed_by_agent_id)
    WHERE claimed_by_agent_id IS NOT NULL;

-- actor_user_id stays required: it names the human accountable for the agent.
-- This column records which of that human's agents actually acted.
ALTER TABLE public.project_activity
    ADD COLUMN actor_agent_id TEXT
        REFERENCES public.agents(id) ON DELETE SET NULL;

ALTER TABLE public.project_activity
    DROP CONSTRAINT project_activity_kind_check;

ALTER TABLE public.project_activity
    ADD CONSTRAINT project_activity_kind_check
    CHECK (kind IN (
        'task_created',
        'task_cancelled',
        'task_claimed',
        'task_status_changed'
    ));

COMMIT;
