-- Apply this migration as one transaction.
BEGIN;

CREATE TABLE public.operations (
    -- Scope each operation to the authenticated Tandem user.
    actor_id UUID NOT NULL
        REFERENCES public.users(id) ON DELETE RESTRICT,

    -- The frontend generates this UUID for a particular action.
    operation_id UUID NOT NULL,

    -- Identify the action, such as "create_project".
    -- This prevents reusing an ID for a different kind of action.
    operation_type TEXT NOT NULL,

    -- Store the validated request so we can compare retries.
    -- JSONB stores structured JSON rather than a plain text string.
    request_payload JSONB NOT NULL,

    -- Store the successful response to return on an identical retry.
    -- It starts empty while the transaction is performing the action.
    response_payload JSONB,

    -- Record when the operation began.
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- One operation ID per user.
    -- PostgreSQL enforces this even for simultaneous requests.
    PRIMARY KEY (actor_id, operation_id)
);

COMMIT;