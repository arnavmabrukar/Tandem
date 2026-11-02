BEGIN;

-- Each task gets its own message counter.
-- The backend will increment it inside the message transaction.
ALTER TABLE public.tasks
    ADD COLUMN message_sequence BIGINT NOT NULL DEFAULT 0
        CHECK (message_sequence >= 0);

-- Human messages have a user sender instead of an agent sender.
ALTER TABLE public.messages
    ALTER COLUMN sender_agent_id DROP NOT NULL;

ALTER TABLE public.messages
    ADD COLUMN sender_user_id UUID
        REFERENCES public.users(id) ON DELETE RESTRICT,

    -- Preserve the human's display name at the time of posting.
    ADD COLUMN sender_name TEXT,

    -- Nullable for compatibility with existing unscoped agent messages.
    ADD COLUMN project_id UUID,
    ADD COLUMN task_id UUID,
    ADD COLUMN sequence BIGINT;

-- Every message must have exactly one kind of sender.
-- Existing agent messages remain valid.
ALTER TABLE public.messages
    ADD CONSTRAINT messages_exactly_one_sender
    CHECK (
        (sender_agent_id IS NOT NULL AND sender_user_id IS NULL)
        OR
        (sender_agent_id IS NULL AND sender_user_id IS NOT NULL)
    );

-- Thread scope is either entirely absent for legacy messages,
-- or entirely present for task messages.
ALTER TABLE public.messages
    ADD CONSTRAINT messages_complete_task_scope
    CHECK (
        (project_id IS NULL AND task_id IS NULL AND sequence IS NULL)
        OR
        (
            project_id IS NOT NULL
            AND task_id IS NOT NULL
            AND sequence IS NOT NULL
            AND sequence >= 1
        )
    );

-- Human messages must be scoped task notes with a meaningful name/body.
-- Check constraints must explicitly reject NULL where necessary.
ALTER TABLE public.messages
    ADD CONSTRAINT messages_human_note_valid
    CHECK (
        sender_user_id IS NULL
        OR
        (
            project_id IS NOT NULL
            AND task_id IS NOT NULL
            AND sequence IS NOT NULL
            AND type = 'human_note'
            AND sender_name IS NOT NULL
            AND length(trim(sender_name)) > 0
            AND length(trim(body)) > 0
        )
    );

-- Verify that the referenced task belongs to the referenced project.
-- Migration 006 created the required unique (project_id, id) constraint.
ALTER TABLE public.messages
    ADD CONSTRAINT messages_task_scope_fk
    FOREIGN KEY (project_id, task_id)
    REFERENCES public.tasks(project_id, id)
    ON DELETE NO ACTION;

-- Each sequence number is unique within its task.
-- Legacy rows with NULL scope remain compatible.
ALTER TABLE public.messages
    ADD CONSTRAINT messages_task_sequence_unique
    UNIQUE (project_id, task_id, sequence);

-- Support a composite foreign key for replies.
ALTER TABLE public.messages
    ADD CONSTRAINT messages_scoped_id_unique
    UNIQUE (project_id, task_id, id);

-- A task-scoped reply must reference a message in the SAME task.
-- The existing reply_to_message_id foreign key still protects legacy replies.
ALTER TABLE public.messages
    ADD CONSTRAINT messages_reply_same_task_fk
    FOREIGN KEY (project_id, task_id, reply_to_message_id)
    REFERENCES public.messages(project_id, task_id, id)
    ON DELETE NO ACTION;

COMMIT;