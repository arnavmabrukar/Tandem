-- Create both tables together.
-- If a statement fails, the transaction cannot commit partially.
BEGIN;

CREATE TABLE public.projects (
    -- Permanent internal ID for this project.
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Require a meaningful project name.
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),

    -- Store the GitHub repository as "owner/repository".
    repository TEXT NOT NULL
        CHECK (repository ~ '^[^/[:space:]]+/[^/[:space:]]+$'),

    -- An empty description is allowed.
    description TEXT NOT NULL DEFAULT '',

    -- Future edits will increment this number.
    -- It lets us detect changes made since a user loaded the project.
    version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),

    -- Record when the project was created.
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.project_memberships (
    -- Memberships must reference an existing project.
    -- Deleting a project also removes its memberships.
    project_id UUID NOT NULL
        REFERENCES public.projects(id) ON DELETE CASCADE,

    -- Memberships must reference an existing Tandem user.
    -- Restrict deletion of users who still have memberships.
    user_id UUID NOT NULL
        REFERENCES public.users(id) ON DELETE RESTRICT,

    -- These values match the roles expected by your frontend.
    role TEXT NOT NULL
        CHECK (role IN ('owner', 'reviewer', 'viewer')),

    -- Record when the user joined the project.
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- A user can have only one membership per project.
    PRIMARY KEY (project_id, user_id)
);

-- The primary key supports lookups starting with project_id.
-- This separate index supports "find this user's projects".
CREATE INDEX project_memberships_user_id_idx
    ON public.project_memberships (user_id);

-- Save both tables and the index.
COMMIT;