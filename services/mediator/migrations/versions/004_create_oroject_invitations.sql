-- create the invitation table and index together 
BEGIN;

CREATE TABLE public.project_invitations(
    -- unique ID used when accepting or revoking this invitation
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- each invitation belong to exactly one project 
    project_id UUID NOT NULL
        REFERENCES public.project(id) ON DELETE CASCADE,
    
    -- store the invited email trimmed and lowercase
    -- python will validate the email format before inserting it
    email TEXT NOT NULL
        CHECK(
            email = lower(btrim(email))
            AND length(email)>0
        ),

    -- role granted when the invitation is accepted 
    role TEXT NOT NULL
        check(role IN('owner','reviewer','viewer')),

    -- record which authenticated user created the invitation
    invited_by UUID NOT NULL
        REFERENCES public.users(id) ON DELETE RESTRICT,
    
    -- an invitation grants no access while pending 
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','accepted','revoked')),
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- pending invitations are usable to seven days 
    -- the acceptance query must explicityly enforce thisdeadline
    expires_at TIMESTAMPTZ NOT NULL
        DEFAULT (now()+interval '7 days'),
    
    -- filledo nly after successful acceptance
    accepted_at TIMESTAMPTZ,

    -- filled only after revocation
    revoked_at TIMESTAMPTZ,
     
    -- require a meaningful expiration time
    CHECK (expires_at > created_at),

    -- keep status and its associated fields consistent
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

-- allow only one pending invitation per email within a project
-- accepted and revoked records remain available as hsitory
CREATE UNIQUE INDEX project_invitations_pending_email_idx
    ON public.project_invitations (project_id, email)
    WHERE status = 'pending';

-- support looking up invitations for a signed-ibn persons email
CREATE INDEX project_invitations_pending_recipient_idc
    ON public.project_invitations (email, expires_at)
    WHERE status = 'pending';

COMMIT;

