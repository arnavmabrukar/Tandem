BEGIN;

ALTER TABLE public.plan_proposal_revisions
    ADD CONSTRAINT plan_revision_project_unique UNIQUE (project_id, plan_id, version);

-- Only one revision of a plan can become live tasks.
CREATE TABLE public.plan_approvals (
    plan_id UUID PRIMARY KEY,
    project_id UUID NOT NULL,
    plan_version BIGINT NOT NULL,
    approved_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    approved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    note TEXT NOT NULL CHECK (length(trim(note)) BETWEEN 1 AND 2000),
    FOREIGN KEY (project_id, plan_id, plan_version)
        REFERENCES public.plan_proposal_revisions(project_id, plan_id, version) ON DELETE RESTRICT,
    UNIQUE (project_id, plan_id)
);

-- Preserve the correspondence between proposal keys and real task IDs.
CREATE TABLE public.plan_tasks (
    project_id UUID NOT NULL,
    plan_id UUID NOT NULL,
    task_key TEXT NOT NULL,
    task_id UUID NOT NULL UNIQUE,
    PRIMARY KEY (plan_id, task_key),
    FOREIGN KEY (project_id, plan_id)
        REFERENCES public.plan_approvals(project_id, plan_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, task_id)
        REFERENCES public.tasks(project_id, id) ON DELETE RESTRICT
);

COMMIT;
