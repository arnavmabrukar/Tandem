-- Apply the table definition as one transaction.
BEGIN;

CREATE TABLE public.users (
    -- Tandem's own unique identifier for this person.
    -- PostgreSQL generates it automatically when we insert a user.
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The Auth0 tenant that issued the verified token.
    auth_issuer TEXT NOT NULL,

    -- The verified token's "sub": Auth0's identifier for the person.
    auth_subject TEXT NOT NULL,

    -- The name shown in the dashboard.
    -- Reject empty names and names containing only spaces.
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),

    -- Record when Tandem first created this user.
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- The same Auth0 identity must map to only one Tandem user.
    CONSTRAINT users_auth_identity_unique
        UNIQUE (auth_issuer, auth_subject)
);

-- Commit the table creation.
COMMIT;