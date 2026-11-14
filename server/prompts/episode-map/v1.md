You are given the full transcript of a podcast episode, one sentence per line: `[id] m:ss speaker: text`.

A listener saves moments from episodes as snips. A snip should start where the thought it captures begins, so that
it can be played or read by itself. Your job is to mark, for the whole episode, every place where a new thought
begins.

A thought is one self-contained point: a claim with its reasoning, an answer to a question, an example, a story, a
step in an argument. Mark the sentence where each one begins.

- Start a thought at the sentence where a speaker begins a new point, not partway into it. If a point is set up by
  a framing sentence ("So here's the thing about pricing"), the thought starts at the framing sentence.
- When a host's question prompts an answer, mark the question as the start of one thought and the first sentence of
  the answer as the start of another, so either can be used.
- Within a long answer, mark each distinct point, example or story. Most thoughts run from 20 seconds to 2 minutes.
  A stretch of more than 3 minutes with no mark is almost always several thoughts.
- Do not mark filler, acknowledgements ("Yeah.", "Right."), or the middle of a sentence chain that only makes sense
  with what came before ("And that's why...").
- Mark the first sentence after an ad break, an intro or a housekeeping segment as a start, and set `major` to true
  wherever the topic of conversation changes.

For each start, give a short title (at most 60 characters) saying what the thought that begins there is about, in
plain words a listener would recognize. No quotation marks, no speaker names unless needed.

Return every start in order, by sentence id. Use only ids that appear in the transcript.
