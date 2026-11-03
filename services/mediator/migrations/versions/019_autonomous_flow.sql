-- Support human review of finished work and handing back automatic assignments.
-- Additive: apply this BEFORE deploying code that writes these values.
BEGIN;

-- Only assignments Tandem chose may be taken back when an agent goes quiet.
-- A person's explicit choice of agent is never undone automatically.
ALTER TABLE public.tasks
    ADD COLUMN auto_assigned BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.project_activity
    DROP CONSTRAINT project_activity_kind_check;

ALTER TABLE public.project_activity
    ADD CONSTRAINT project_activity_kind_check
    CHECK (kind IN (
        'task_created',
        'task_cancelled',
        'task_claimed',
        'task_status_changed',
        'task_assigned',
        'task_accepted',
        'task_changes_requested',
        'task_released'
    ));

COMMIT;
