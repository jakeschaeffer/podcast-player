import { useEffect, useRef, useState } from "react";
import { api, describeError, unwrap } from "../api/client";
import type { Snip } from "../api/types";
import { Icon } from "../components/Icon";
import { useToast } from "../components/Toast";
import { invalidate } from "../lib/useQuery";

/**
 * A snip's title that turns into a text box when clicked. Enter or clicking away saves, Escape puts it back (and is
 * marked handled, so a card that closes on Escape stays open). Only the title changes: the server edits it in place,
 * with no new revision or clip, and keeps it as the owner's title, even over a summary still being written.
 * `className` gives the title's size: the Snips page's card or the player's snip card.
 */
export function TitleEdit({ snip, onSaved, className = "card__title" }: { snip: Snip; onSaved: (s: Snip) => void; className?: string }) {
  const rev = snip.revision!;
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  /** Set once Enter, Escape or a click away has ended this edit, so the blur that follows does not save it again. */
  const ended = useRef(false);
  const toast = useToast();
  const start = () => {
    ended.current = false;
    setDraft(rev.title ?? "");
  };

  useEffect(() => {
    if (draft !== null) field.current?.select();
  }, [draft !== null]); // eslint-disable-line react-hooks/exhaustive-deps -- select once, when editing starts

  async function save() {
    if (draft === null || ended.current) return;
    ended.current = true;
    const title = draft.trim();
    if (!title || title === (rev.title ?? "")) return setDraft(null);
    setSaving(true);
    try {
      const updated = await unwrap(api.PATCH("/v1/snips/{id}", { params: { path: { id: snip.id } }, body: { title, if_revision: rev.id } }));
      invalidate("snips:episode:");
      onSaved(updated);
      setDraft(null);
    } catch (e) {
      ended.current = false; // keep the text box open with what was typed
      toast(describeError(e));
    } finally {
      setSaving(false);
    }
  }

  if (draft === null) {
    // The pencil stays on the line with the title's last word, rather than wrapping onto a line of its own.
    const shown = rev.title ?? "Snip";
    const cut = shown.lastIndexOf(" ") + 1;
    return (
      <button className={`${className} title-edit`} onClick={start} aria-label={`Edit title: ${shown}`}>
        {shown.slice(0, cut)}
        <span className="title-edit__end">
          {shown.slice(cut)}
          <Icon name="edit" size={20} />
        </span>
      </button>
    );
  }
  return (
    <textarea
      ref={field}
      className={`${className} title-edit__field`}
      value={draft}
      maxLength={120}
      rows={2}
      disabled={saving}
      aria-label="Title"
      onChange={(e) => setDraft(e.target.value.replace(/\n/g, " "))}
      onBlur={() => void save()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void save();
        } else if (e.key === "Escape") {
          e.preventDefault();
          ended.current = true;
          setDraft(null);
        }
      }}
    />
  );
}
