import { useEffect, useState } from "react";
import { describeError } from "../api/client";
import { processEpisode } from "../api/episodes";
import type { EpisodeDetail } from "../api/types";
import { clock } from "../lib/time";
import { useEngine } from "./PlayerContext";

/** ElevenLabs' rate, as the iPhone app and the show settings quote it. */
const CENTS_PER_HOUR = 22;

/**
 * The Transcript tab of an episode with no transcript: ask for it (the server fetches the audio if needed, transcribes
 * it, aligns the publisher's text when there is any, and summarizes), after a confirmation that names the cost. While
 * it works, the episode is re-read every five seconds until the transcript is there or the job stops.
 */
export function TranscribePrompt({ episode }: { episode: EpisodeDetail }) {
  const engine = useEngine();
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { audio, transcript } = episode.processing;
  const working = sending || transcript === "queued" || transcript === "running" || audio === "queued" || audio === "running";

  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => void engine.refreshEpisode().catch(() => undefined), 5000);
    return () => window.clearInterval(timer);
  }, [working, engine]);

  const ms = episode.asset?.duration_ms ?? episode.duration_ms ?? null;
  const estimate = ms ? `About ${Math.ceil((ms / 3_600_000) * CENTS_PER_HOUR)}¢ for ${clock(ms)} of audio.` : "Billed per audio hour.";

  async function transcribe() {
    setConfirming(false);
    setSending(true);
    try {
      await processEpisode(episode.id);
      setError(null);
      await engine.refreshEpisode();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="transcribe">
      {working ? (
        <>
          <h3 className="transcribe__title">Transcribing…</h3>
          <p className="transcribe__note">The transcript appears here when it's ready, usually within a few minutes.</p>
        </>
      ) : (
        <>
          <h3 className="transcribe__title">{transcript === "failed" ? "Transcription failed" : transcript === "deferred" ? "Transcription is waiting" : "No transcript yet"}</h3>
          {confirming ? (
            <div className="transcribe__actions">
              <button className="btn btn--accent" onClick={() => void transcribe()}>Transcribe</button>
              <button className="btn btn--soft" onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          ) : (
            <button className="btn btn--accent" onClick={() => setConfirming(true)}>{transcript === "failed" ? "Try again" : "Transcribe this episode"}</button>
          )}
          <p className="transcribe__note">{estimate}</p>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
