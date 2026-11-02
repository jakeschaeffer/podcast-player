/**
 * Manual or automatic processing for a show, with what each costs. Automatic transcribes every new episode with
 * ElevenLabs (billed per hour of audio), so it is never the default: a show added from search starts manual.
 */
export function ProcessingChoice({ automatic, onChange }: { automatic: boolean; onChange: (automatic: boolean) => void }) {
  return (
    <div className="choice">
      <div className="seg" role="group" aria-label="Processing" style={{ marginTop: 0 }}>
        <button type="button" aria-pressed={!automatic} onClick={() => onChange(false)}>Manual</button>
        <button type="button" aria-pressed={automatic} onClick={() => onChange(true)}>Automatic</button>
      </div>
      <p className="choice__note">
        {automatic
          ? "Each new episode is downloaded, transcribed and summarized when it comes out. Transcription is billed per hour of audio (about 22¢ an hour)."
          : "Episodes are listed and play right away. Nothing is transcribed until you ask, or until you snip an episode (a snip needs its transcript)."}
      </p>
    </div>
  );
}
