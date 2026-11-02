-- Device-side times, so replays from an offline outbox keep their real order. Both are Unix ms on the reporting
-- device's clock, capped at the server's receipt time; NULL for clients that do not send them.
ALTER TABLE playback_state ADD COLUMN observed_at INTEGER; -- when the device observed this position
ALTER TABLE snip ADD COLUMN captured_at INTEGER;           -- when the owner tapped Snip
