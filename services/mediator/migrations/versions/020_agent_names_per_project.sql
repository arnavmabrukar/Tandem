-- Agent names no longer need to be unique across all of Tandem. Each project now
-- has its own agent records, and registration keeps names unique within a project.
--
-- Apply this AFTER deploying the matching code: earlier code relies on this index.
DROP INDEX IF EXISTS public.agents_name_uidx;
