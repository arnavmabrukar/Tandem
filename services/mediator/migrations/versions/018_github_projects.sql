BEGIN;
-- GitHub credentials never leave the backend; tokens are encrypted at rest.
CREATE TABLE public.github_connections (
    user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    github_user_id BIGINT NOT NULL,
    login TEXT NOT NULL,
    token_encrypted TEXT NOT NULL,
    expires_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE public.github_oauth_states (
    state_hash TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    verifier TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '10 minutes'
);
ALTER TABLE public.projects
    ADD COLUMN github_repository_id BIGINT,
    ADD COLUMN github_installation_id BIGINT,
    ADD COLUMN tracked_branch TEXT,
    ADD COLUMN connected_by UUID REFERENCES public.users(id),
    ADD COLUMN disconnected_at TIMESTAMPTZ,
    ADD COLUMN disconnected_by UUID REFERENCES public.users(id),
    ADD COLUMN archived_access JSONB;
CREATE UNIQUE INDEX projects_connected_repository_unique
    ON public.projects(connected_by, github_repository_id)
    WHERE disconnected_at IS NULL AND github_repository_id IS NOT NULL;
-- Prevent an invitation/OAuth race from granting access to an archived project.
-- Locking the project makes membership changes serialize with disconnection.
CREATE FUNCTION public.reject_archived_project_membership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM id FROM public.projects WHERE id=NEW.project_id
        AND disconnected_at IS NULL FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Project is disconnected' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER membership_active_project BEFORE INSERT OR UPDATE ON public.project_memberships
FOR EACH ROW EXECUTE FUNCTION public.reject_archived_project_membership();
COMMIT;
