-- Ad breaks found in a recording (server/src/core/ads/detect.ts). Derived from the asset's transcripts and summary,
-- so it is a cache rather than an artifact: one row per asset, replaced whenever an input or the detector changes.
CREATE TABLE ad_detection (
  audio_asset_id TEXT PRIMARY KEY REFERENCES audio_asset(id),
  detector       TEXT NOT NULL,             -- AD_DETECTOR_VERSION that produced it
  inputs         TEXT NOT NULL,             -- JSON {"asr","publisher","summary"}: the ids it was computed from
  breaks         TEXT NOT NULL,             -- JSON [{"start_ms","end_ms","confidence","sources","cue"}]
  created_at     INTEGER NOT NULL
);
