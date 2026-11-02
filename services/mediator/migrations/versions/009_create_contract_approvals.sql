-- Store contract review requests and decisions together.
BEGIN;

CREATE TABLE public.contract_approvals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The composite foreign key below keeps the task in this project.
    project_id UUID NOT NULL,
    task_id UUID NOT NULL,

    -- Snapshot the exact review target. The API must compare these values
    -- with the current task and project before accepting a decision.
    repository TEXT NOT NULL CHECK (length(trim(repository)) > 0),
    task_version BIGINT NOT NULL CHECK (task_version >= 1),
    contract_version BIGINT NOT NULL CHECK (contract_version >= 1),

    -- Preserve the requirements that were presented to the reviewer.
    -- Later task edits must not rewrite this historical snapshot.
    contract_summary TEXT NOT NULL,
    contract_paths TEXT[] NOT NULL DEFAULT '{}',
    acceptance_criteria TEXT[] NOT NULL DEFAULT '{}',

    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected', 'stale')),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

    -- These fields remain NULL until a human makes a decision.
    decided_by UUID REFERENCES public.users(id) ON DELETE RESTRICT,
    decided_by_name TEXT,
    decided_at TIMESTAMPTZ,
    note TEXT,

    CONSTRAINT contract_approvals_task_fk
        FOREIGN KEY (project_id, task_id)
        REFERENCES public.tasks (project_id, id)
        ON DELETE NO ACTION,

    -- A decided review needs a complete audit record. Undecided/stale
    -- requests must not pretend that a human approved or rejected them.
    CONSTRAINT contract_approvals_decision_complete CHECK (
        (
            status IN ('pending', 'stale')
            AND decided_by IS NULL AND decided_by_name IS NULL
            AND decided_at IS NULL AND note IS NULL
        )
        OR
        (
            status IN ('approved', 'rejected')
            AND decided_by IS NOT NULL
            AND decided_by_name IS NOT NULL
            AND length(trim(decided_by_name)) > 0
            AND decided_at IS NOT NULL
            AND note IS NOT NULL
            AND length(trim(note)) > 0
            AND length(note) <= 2000
        )
    )
);

-- At most one request may be waiting for a decision on a given task.
-- Previous decisions remain available as review history.
CREATE UNIQUE INDEX contract_approvals_one_pending_task_idx
    ON public.contract_approvals (project_id, task_id)
    WHERE status = 'pending';

-- Support loading a project's review history and checking task references.
CREATE INDEX contract_approvals_project_task_idx
    ON public.contract_approvals (project_id, task_id, requested_at, id);

-- This migration creates storage only. The API will create review requests.
COMMIT;
