import { useState } from "react";
import { api, describeError, unwrap } from "../api/client";
import type { Feed } from "../api/types";
import { Sheet } from "../components/Sheet";
import { ProcessingChoice } from "./ProcessingChoice";

/**
 * A show's settings: switch between manual and automatic processing (applies to episodes published from now on),
 * or unsubscribe. Unsubscribing deletes the show's episodes, downloaded recordings and transcripts (which may have been
 * paid for), so it takes a second tap. The server refuses while snips use its recordings; its message is shown as is.
 */
export function ShowSettingsSheet({ feed, onClose, onChanged, onRemoved }: { feed: Feed; onClose: () => void; onChanged: (feed: Feed) => void; onRemoved: () => void }) {
  const [automatic, setAutomatic] = useState(feed.auto_process);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(async () => {
      onChanged(await unwrap(api.PATCH("/v1/feeds/{id}", { params: { path: { id: feed.id } }, body: { auto_process: automatic } })));
      onClose();
    });

  const remove = () =>
    run(async () => {
      if (!confirmRemove) {
        setConfirmRemove(true);
        return;
      }
      await unwrap(api.DELETE("/v1/feeds/{id}", { params: { path: { id: feed.id } } }));
      onRemoved();
    });

  return (
    <Sheet onClose={onClose} label={`Settings for ${feed.title ?? "this show"}`}>
      <div className="sheet__title">{feed.title ?? "Show"}</div>
      <ProcessingChoice automatic={automatic} onChange={setAutomatic} />
      <button className="btn btn--accent btn--block" onClick={() => void save()} disabled={busy || automatic === feed.auto_process}>
        Save
      </button>
      {error && <p className="error" role="alert">{error}</p>}
      {confirmRemove && <p className="choice__note">This deletes the show’s episodes, downloaded recordings and transcripts. Tap again to confirm.</p>}
      <button className="btn btn--ghost btn--danger btn--block" onClick={() => void remove()} disabled={busy}>
        {confirmRemove ? "Delete show" : "Unsubscribe"}
      </button>
    </Sheet>
  );
}
