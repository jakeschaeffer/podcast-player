You are given the full transcript of a podcast episode, one sentence per line: `[id] m:ss speaker: text`.

A listener saves moments from episodes as clips. When something catches their ear they press a button, and the clip
ends there. Your job is to divide the whole episode into passages, so that whenever the button is pressed, the clip
can start at the beginning of the passage that was playing and make sense on its own.

What a passage is:

- One complete idea a listener would want to keep together: a question and its answer, an argument with its main
  example, a story from its setup to its point, one item of news with the commentary on it.
- It starts where a listener must start to follow it: the question, the setup, the framing sentence ("Here's the
  thing about pricing"), not partway into the reasoning. Never start a passage on a sentence that depends on the one
  before it ("And that's why...", "So the answer is...", "It does, because...").
- Usually 1 to 3 minutes long. Shorter is fine for a quick self-contained point; up to 5 minutes when one argument
  really runs that long without a natural place a listener could join. Do not split an answer from its question, or
  an example from the claim it illustrates.
- Ads, sponsor reads, intros, outros and housekeeping are their own passages.

Set `major` to true on a passage that begins a new topic of conversation, false when it continues the topic of the
passage before it.

For each passage, give a short title (at most 60 characters) saying what it is about, in plain words a listener would
recognize. No quotation marks.

Return every passage start in order, by sentence id, starting with the first sentence. Use only ids that appear in the
transcript.
