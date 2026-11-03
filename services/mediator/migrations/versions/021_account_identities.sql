-- One Tandem user can now have several sign-ins, such as a password and Google.
-- Auth0 gives each sign-in a different subject, so they used to become separate users.
--
-- Apply this BEFORE deploying the matching code: that code reads these tables.
-- The migration only adds to the schema, so the earlier code keeps working.
BEGIN;

-- Sign-ins sync the name from Auth0 until the person chooses their own.
ALTER TABLE public.users
    ADD COLUMN name_customized BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE public.user_identities (
    auth_issuer TEXT NOT NULL,
    auth_subject TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

    -- Set only while Auth0 confirms this sign-in's email is verified, and never from
    -- an unverified one. Otherwise anyone could register someone else's address and
    -- be joined to that person's account.
    verified_email TEXT CHECK (verified_email = lower(verified_email)),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (auth_issuer, auth_subject)
);

CREATE INDEX user_identities_user_idx ON public.user_identities (user_id);
CREATE INDEX user_identities_email_idx ON public.user_identities (verified_email)
    WHERE verified_email IS NOT NULL;

-- Emails weren't stored before, so each one is filled in at that sign-in's next login.
INSERT INTO public.user_identities (auth_issuer, auth_subject, user_id, created_at)
SELECT auth_issuer, auth_subject, id, created_at FROM public.users;

-- Keeps identities complete when a user is created by the earlier code during a deploy.
CREATE FUNCTION public.add_user_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO public.user_identities (auth_issuer, auth_subject, user_id)
    VALUES (NEW.auth_issuer, NEW.auth_subject, NEW.id)
    ON CONFLICT DO NOTHING;
    RETURN NEW;
END;
$$;

CREATE TRIGGER users_add_identity AFTER INSERT ON public.users
    FOR EACH ROW EXECUTE FUNCTION public.add_user_identity();

-- A merge deletes a user, so keep a record of it. These IDs deliberately aren't
-- foreign keys: the merged user no longer exists, and the record must outlive both.
CREATE TABLE public.user_merges (
    kept_user_id UUID NOT NULL,
    merged_user_id UUID NOT NULL,
    merged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (merged_user_id)
);

-- These foreign keys span an owner column on two tables. Merging moves both sides,
-- so the check has to wait until both have moved. They stay immediate unless a
-- transaction explicitly defers them, so all other code behaves as before.
ALTER TABLE public.agent_project_grants
    ALTER CONSTRAINT agent_project_grants_agent_owner_fk DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE public.agent_project_grants
    ALTER CONSTRAINT agent_project_grants_membership_fk DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE public.plan_proposal_revisions
    ALTER CONSTRAINT plan_revision_agent_owner_fk DEFERRABLE INITIALLY IMMEDIATE;

COMMIT;
