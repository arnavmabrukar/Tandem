-- Create the invitation table and index together.
BEGIN;

CREATE TABLE public.project_invitations (
    -- Unique ID used when accepting or revoking this invitation.
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Each invitation belongs to exactly one project.
    project_id UUID NOT NULL
        REFERENCES public.projects(id) ON DELETE CASCADE,

    -- Store the invited email trimmed and lowercase.
    -- Python will validate the email format before inserting it.
    email TEXT NOT NULL
        CHECK (
            email = lower(btrim(email))
            AND length(email) > 0
        ),

    -- The role granted when the invitation is accepted.
    role TEXT NOT NULL
        CHECK (role IN ('owner', 'reviewer', 'viewer')),

    -- Record which authenticated user created the invitation.
    invited_by UUID NOT NULL
        REFERENCES public.users(id) ON DELETE RESTRICT,

    -- An invitation grants no access while pending.
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'revoked')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Pending invitations are usable for seven days.
    -- The acceptance query must explicitly enforce this deadline.
    expires_at TIMESTAMPTZ NOT NULL
        DEFAULT (now() + interval '7 days'),

    -- Filled only after successful acceptance.
    accepted_by UUID
        REFERENCES public.users(id) ON DELETE RESTRICT,
    accepted_at TIMESTAMPTZ,

    -- Filled only after revocation.
    revoked_at TIMESTAMPTZ,

    -- Require a meaningful expiration time.
    CHECK (expires_at > created_at),

    -- Keep status and its associated fields consistent.
    CONSTRAINT project_invitations_state_check CHECK (
        (
            status = 'pending'
            AND accepted_by IS NULL
            AND accepted_at IS NULL
            AND revoked_at IS NULL
        )
        OR
        (
            status = 'accepted'
            AND accepted_by IS NOT NULL
            AND accepted_at IS NOT NULL
            AND revoked_at IS NULL
        )
        OR
        (
            status = 'revoked'
            AND accepted_by IS NULL
            AND accepted_at IS NULL
            AND revoked_at IS NOT NULL
        )
    )
);

-- Allow only one pending invitation per email within a project.
-- Accepted and revoked records remain available as history.
CREATE UNIQUE INDEX project_invitations_pending_email_idx
    ON public.project_invitations (project_id, email)
    WHERE status = 'pending';

-- Support looking up invitations for a signed-in person's email.
CREATE INDEX project_invitations_pending_recipient_idx
    ON public.project_invitations (email, expires_at)
    WHERE status = 'pending';

COMMIT;