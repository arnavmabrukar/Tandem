-- Assignment reserves intended work; claiming still starts execution separately.
BEGIN;
ALTER TABLE public.tasks
    ADD COLUMN assigned_agent_id TEXT REFERENCES public.agents(id) ON DELETE RESTRICT;
CREATE INDEX tasks_assignment_idx ON public.tasks (project_id, assigned_agent_id)
    WHERE assigned_agent_id IS NOT NULL;
ALTER TABLE public.project_activity DROP CONSTRAINT project_activity_kind_check;
ALTER TABLE public.project_activity ADD CONSTRAINT project_activity_kind_check
    CHECK (kind IN ('task_created', 'task_cancelled', 'task_claimed',
                   'task_status_changed', 'task_assigned'));
COMMIT;
