-- Messaging (the global chat POC, P1): the `channel` + `message` builtin types +
-- their typed tables, plus per-(channel,user) read tracking for unread counts.

-- WHY: messaging reuses the entity + membership + RBAC + events substrate — a
-- channel is a scoped entity, membership = who's in, a DM = a 2-member channel.
-- Reach is by MEMBERSHIP ON THE CHANNEL, NOT company, so a DM stays private to its
-- two users: `channel.scope_parents = '[]'` (direct channel-membership is the gate,
-- like a project's own membership) and `message.scope_parents = '["channel_id"]'` so
-- message-reach CASCADES to channel-membership. The generated RBAC cascade
-- (type_cache::builtin_table maps channel→channels, message→messages) wires this for
-- free — no per-type RBAC. Message bodies are RAW Markdown TEXT; the FE renders them
-- through a safe md→html (never raw HTML), so there is NO server-side sanitizer here
-- (the same contract as case_comments). Near-real-time is by polling
-- (GET /messages?after=<cursor>); SSE + Web Push are a later phase.

INSERT INTO type_definitions
  (type_id, rid_prefix, display_name, display_name_plural, rail_icon, is_builtin, grid_served, ordinal, scope_parents) VALUES
  ('channel', 'CHN', 'Channel', 'Channels', 'bi-chat-dots', true, true,  95, '[]'),
  ('message', 'MSG', 'Message', 'Messages', 'bi-chat-text', true, true,  96, '["channel_id"]');

-- Readonly field catalog (so /api/types is complete + a future /objects browse can
-- render columns). The messaging surface itself is /api/channels + /api/messages.
INSERT INTO type_fields (type_id, field, ordinal, data_type, perm_class) VALUES
  ('channel', 'name',       10, 'string',   'readonly'),
  ('channel', 'kind',       20, 'string',   'readonly'),
  ('channel', 'created_at', 30, 'datetime', 'readonly'),
  ('message', 'body',       10, 'string',   'readonly'),
  ('message', 'channel_id', 20, 'string',   'readonly'),
  ('message', 'author_id',  30, 'string',   'readonly'),
  ('message', 'created_at', 40, 'datetime', 'readonly');

-- A channel: a registered entity (membership = who's in). No company_id — reach is
-- the channel's own membership, so a DM is invisible to non-members.
CREATE TABLE channels (
    redpash_id text PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    name       text NOT NULL DEFAULT '',
    kind       text NOT NULL DEFAULT 'channel' CHECK (kind IN ('channel', 'dm')),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- A message: a registered entity scoped to its channel (the cascade arm). author_id
-- is a workflow ref (SET NULL on user scrub), not an access edge — reach flows
-- through the channel. Bodies are raw Markdown text (rendered safe client-side).
CREATE TABLE messages (
    redpash_id text PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    channel_id text NOT NULL REFERENCES channels(redpash_id) ON DELETE CASCADE,
    author_id  text REFERENCES users(redpash_id) ON DELETE SET NULL,
    body       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
-- The polling cursor index: messages of a channel newer than a timestamp, ascending.
CREATE INDEX messages_channel_time_idx ON messages (channel_id, created_at);

-- Last message a user has read in a channel → unread = messages newer than this.
CREATE TABLE channel_reads (
    channel_id   text NOT NULL REFERENCES channels(redpash_id) ON DELETE CASCADE,
    user_id      text NOT NULL REFERENCES users(redpash_id) ON DELETE CASCADE,
    last_read_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, user_id)
);
