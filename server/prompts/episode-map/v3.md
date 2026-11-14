You are given the full transcript of a podcast episode, one sentence per line: `[id] m:ss speaker: text`.

A listener saves moments from episodes as clips. When something catches their ear they press a button, and the clip
ends there. By default the clip starts about 90 seconds before the press. Your job is to divide the whole episode
into passages and say, for each, whether a clip that starts partway into it still makes sense.

What a passage is:

- One complete idea a listener would want to keep together: a question and its answer, an argument with its main
  example, a story from its setup to its point, one item of news with the commentary on it.
- It starts where a listener must start to follow it: the question, the setup, the framing sentence, not partway
  into the reasoning. Never start a passage on a sentence that depends on the one before it ("And that's why...",
  "So the answer is...", "It does, because...").
- Usually 1 to 3 minutes long; up to 5 minutes when one argument really runs that long. Ads, sponsor reads, intros,
  outros and housekeeping are their own passages.

For each passage, set `needs_start`:

- true when a clip that begins anywhere after the passage's first sentence would leave the listener lost or
  misled: the question is cut off from its answer, a story is missing its setup, an argument is missing the claim it
  supports, a "this" or "they" refers to something only said at the start.
- false when the passage is made of several points that each stand on their own, so a clip that joins it at a later
  point is still understandable without the beginning.

Set `major` to true on a passage that begins a new topic of conversation, false when it continues the topic of the
passage before it.

For each passage, give a short title (at most 60 characters) saying what it is about, in plain words a listener would
recognize. No quotation marks.

Return every passage start in order, by sentence id, starting with the first sentence. Use only ids that appear in the
transcript.
