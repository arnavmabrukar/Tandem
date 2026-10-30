-- MVP coordination tables for register / send / poll / ack.
-- Recipient addressing uses agent ids (not names).

CREATE TABLE IF NOT EXISTS agents (
    id              text PRIMARY KEY,
    name            text NOT NULL,
    client          text NOT NULL
                    CHECK (client IN ('Claude Code', 'Codex', 'Other')),
    token_hash      text NOT NULL UNIQUE,
    owner           text NOT NULL DEFAULT '',
    machine         text NOT NULL DEFAULT '',
    branch          text NOT NULL DEFAULT '',
    capabilities    text[] NOT NULL DEFAULT '{}',
    grant_status    text NOT NULL DEFAULT 'active'
                    CHECK (grant_status IN ('pending', 'active', 'revoked')),
    presence        text NOT NULL DEFAULT 'offline'
                    CHECK (presence IN ('online', 'stale', 'offline')),
    last_seen_at    timestamptz,
    session         text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS agents_name_uidx ON agents (name);

CREATE TABLE IF NOT EXISTS messages (
    id                   text PRIMARY KEY,
    sender_agent_id      text NOT NULL REFERENCES agents (id),
    body                 text NOT NULL,
    type                 text NOT NULL DEFAULT 'status'
                         CHECK (type IN ('question', 'answer', 'status', 'result', 'human_note')),
    reply_to_message_id  text REFERENCES messages (id),
    created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_sender_created_idx
    ON messages (sender_agent_id, created_at);

CREATE TABLE IF NOT EXISTS deliveries (
    id                   text PRIMARY KEY,
    message_id           text NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    recipient_agent_id   text NOT NULL REFERENCES agents (id),
    status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'received')),
    created_at           timestamptz NOT NULL DEFAULT now(),
    received_at          timestamptz,
    UNIQUE (message_id, recipient_agent_id)
);

CREATE INDEX IF NOT EXISTS deliveries_inbox_idx
    ON deliveries (recipient_agent_id, status, created_at);
