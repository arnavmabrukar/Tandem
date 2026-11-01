-- Create the task foundation as one transaction.
BEGIN;

CREATE TABLE public.tasks (
    -- Tandem generates a permanent ID for each task.
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Every task belongs to exactly one project.
    project_id UUID NOT NULL
        REFERENCES public.projects(id) ON DELETE CASCADE,

    -- Record which human created or approved this task.
    -- Future meta-agent proposals will retain their own provenance.
    created_by UUID NOT NULL
        REFERENCES public.users(id) ON DELETE RESTRICT,

    -- Reject empty titles and titles containing only whitespace.
    title TEXT NOT NULL
        CHECK (length(trim(title)) BETWEEN 1 AND 200),

    -- Longer instructions explaining the work.
    description TEXT NOT NULL DEFAULT '',

    -- Use the status names already understood by the dashboard.
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN (
            'open',
            'claimed',
            'in_progress',
            'in_review',
            'approved',
            'merged',
            'blocked',
            'conflict',
            'cancelled'
        )),

    -- Increment whenever task state changes.
    -- The API will compare versions to reject stale updates.
    version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),

    -- Version the work requirements separately from task progress.
    contract_version BIGINT NOT NULL DEFAULT 1
        CHECK (contract_version >= 1),

    -- A short explanation of the agreed scope.
    contract_summary TEXT NOT NULL DEFAULT '',

    -- Paths describe the intended scope; they do not acquire file locks.
    contract_paths TEXT[] NOT NULL DEFAULT '{}',

    -- Conditions the result must satisfy before review approval.
    acceptance_criteria TEXT[] NOT NULL DEFAULT '{}',

    -- Latest human-readable progress update.
    progress TEXT NOT NULL DEFAULT '',

    -- Creation time and most recent modification time.
    -- Future UPDATE queries must explicitly update updated_at.
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Support loading a project's tasks in creation order.
CREATE INDEX tasks_project_created_idx
    ON public.tasks (project_id, created_at, id);

COMMIT;