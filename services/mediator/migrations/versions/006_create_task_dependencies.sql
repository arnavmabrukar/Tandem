-- Apply all dependency schema changes together.
BEGIN;

-- A composite foreign key needs a matching unique constraint.
-- This lets PostgreSQL verify both task identity and project ownership.
ALTER TABLE public.tasks
    ADD CONSTRAINT tasks_project_id_id_unique
    UNIQUE (project_id, id);

CREATE TABLE public.task_dependencies (
    -- Both ends of a dependency must belong to this project.
    project_id UUID NOT NULL,

    -- The task that must wait.
    task_id UUID NOT NULL,

    -- The prerequisite task it waits for.
    depends_on_task_id UUID NOT NULL,

    -- Record when this relationship was created.
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Prevent storing the same dependency twice.
    PRIMARY KEY (project_id, task_id, depends_on_task_id),

    -- Verify that the waiting task belongs to this project.
    -- Deleting it removes its dependency relationships.
    CONSTRAINT task_dependencies_task_fk
        FOREIGN KEY (project_id, task_id)
        REFERENCES public.tasks (project_id, id)
        ON DELETE CASCADE,

    -- Verify that the prerequisite belongs to the SAME project.
    -- Deleting it also removes the relationship.
    CONSTRAINT task_dependencies_prerequisite_fk
        FOREIGN KEY (project_id, depends_on_task_id)
        REFERENCES public.tasks (project_id, id)
        ON DELETE CASCADE,

    -- A task cannot wait for itself.
    CONSTRAINT task_dependencies_no_self
        CHECK (task_id <> depends_on_task_id)
);

-- The primary key supports finding a task's prerequisites.
-- This index supports the reverse: which tasks depend on this one?
CREATE INDEX task_dependencies_prerequisite_idx
    ON public.task_dependencies (project_id, depends_on_task_id);

COMMIT;