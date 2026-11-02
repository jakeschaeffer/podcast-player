-- A public page listing every shared snip from one episode, created only when the owner shares the episode.
-- One link per episode; revoking it turns the page into a 410 and sharing again brings the same link back.
CREATE TABLE episode_share (
  id           TEXT PRIMARY KEY,
  episode_id   TEXT NOT NULL UNIQUE REFERENCES episode(id),
  share_token  TEXT NOT NULL UNIQUE,
  share_state  TEXT NOT NULL DEFAULT 'active', -- 'active' | 'revoked'
  created_at   INTEGER NOT NULL,
  revoked_at   INTEGER
);
