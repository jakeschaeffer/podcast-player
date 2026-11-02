-- Up next as the owner arranges it (services/upNext.ts). Episodes heard partway are up next without a row; a row
-- gives an episode its place in the order (position, set at placed_at; listening to the episode after that clears
-- it, so an episode left partway goes back to the top), adds one not yet started (added_at), or takes one out until
-- it is played again or added back (hidden_at).
CREATE TABLE up_next (
  episode_id TEXT PRIMARY KEY REFERENCES episode(id) ON DELETE CASCADE,
  position   REAL,
  placed_at  INTEGER,
  added_at   INTEGER,
  hidden_at  INTEGER
);
