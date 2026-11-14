You are given the full transcript of a podcast episode, one sentence per line: `[id] m:ss speaker: text`.

A listener saves clips while listening. When something catches their ear they press a button; the clip ends there
and has to start somewhere before it. Your job is to divide the whole episode into passages so that, wherever the
button is pressed, the start of the passage that was playing is the right place for the clip to start.

So think of each passage as the clip a listener would want if they pressed the button at its end:

- It contains the point that would make someone press the button, and everything a newcomer needs to follow that
  point: the question it answers, the claim it supports, the setup of the story.
- It starts on a sentence that stands on its own. Never start a passage on a sentence that depends on the one before
  it ("And that's why...", "So the answer is...", "Right.", "It does, because...", a "this" or "they" that points
  back).
- It is no longer than that. When an answer or a monologue runs long and moves on to a new point that can be
  followed without what came before, start a new passage there, even though the same person is still talking about
  the same subject. Keep a question with the first part of its answer.
- Most passages run 40 seconds to 2 minutes; a few run to 3 or 4 when one argument truly needs it. Ads, sponsor
  reads, intros, outros and housekeeping are their own passages.

Set `major` to true on a passage that begins a new topic of conversation, false when it continues the topic of the
passage before it.

For each passage, give a short title (at most 60 characters) saying what it is about, in plain words a listener would
recognize. No quotation marks.

Return every passage start in order, by sentence id, starting with the first sentence. Use only ids that appear in the
transcript.
