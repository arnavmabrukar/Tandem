-- Owners opt projects into recurring delegation. Existing projects stay manual.
BEGIN;
ALTER TABLE public.projects
    ADD COLUMN auto_delegate BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN auto_delegate_by UUID REFERENCES public.users(id) ON DELETE RESTRICT,
    ADD CONSTRAINT projects_auto_delegate_owner CHECK (NOT auto_delegate OR auto_delegate_by IS NOT NULL);
COMMIT;
