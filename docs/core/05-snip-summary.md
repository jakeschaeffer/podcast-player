# 5. Snip summarization

**Contract:** given the exact excerpt of a snip and light context, produce a short title and a one-to-three-sentence summary in which every claim is supported by the excerpt. Output that cannot be validated is not published.

This is a separate function from selection on purpose. A span can come from the model, the heuristic, or a manual edit, and the summary must always describe the final span. Two small calls are easier to evaluate than one combined call; if latency ever justifies it, the orchestration can merge them without changing either contract.

## Pure core

```ts
summarizeSnip(input: {
  excerpt: Sentence[];                  // sentences with ids, speaker labels, text; the only source of facts
  context: {
    show_title: string; episode_title: string;
    speaker_names?: Record<string, string>;   // label → name, only when known from episode metadata
    preceding?: Sentence[];             // up to two sentences before the span, for pronoun resolution only
  };
  style: { title_max: 60; summary_max: 320; max_sentences: 3 };
  model: TextModel;
}): Promise<SnipSummary | SummaryRejection>

type SnipSummary = {
  title: string;
  summary: string;
  claims: { text: string; sentence_ids: number[] }[];   // each summary sentence with its support
  model: string; prompt_version: string;
}
```

## Prompt shape

System: describe what a speaker said, in the third person and present tense; use "the host" and "the guest" or the names supplied in context, never a name that only appears in the audio; preserve hedges and uncertainty the speaker expressed; no advice, no evaluation, no "in this clip". User: show and episode titles, the preceding sentences marked as context that may not be summarized, the excerpt sentences with ids, and the JSON schema. Prompts live in `server/prompts/snip-summary/v<N>.md` and the version is recorded on the revision.

## Validation, in order

1. Schema and lengths: title ≤ 60 characters, summary ≤ 320 characters and ≤ 3 sentences, at least one claim.
2. Citations: every `sentence_ids` entry exists in the excerpt, and every summary sentence has a claim.
3. Names: every capitalized token in the title and summary that looks like a name must appear in the excerpt, the episode title, the show title, or the supplied speaker names. This cheap check catches the most embarrassing failure, an invented speaker.
4. Context leak: no claim may cite only preceding sentences; the preceding sentences are not citable at all.

A failure regenerates once with the failure reason appended to the prompt. A second failure records `summary = null`, sets `title` to the first eight words of the excerpt followed by an ellipsis, and lets the revision become ready: the public page then shows the excerpt without a summary, and a background retry replaces the title and summary when it succeeds. Nothing fabricated reaches the page, and the link does not stay stuck on "preparing" because of a model.

## Model adapter

```ts
interface TextModel {
  readonly name: string;
  generate<T>(req: { system: string; user: string; schema: JsonSchema; max_tokens?: number; timeout_ms?: number })
    : Promise<{ data: T; model: string; input_tokens?: number; output_tokens?: number }>;
}
```

Two adapters are planned. `codex-cli` wraps `codex exec` with a JSON output schema and the owner's subscription, as decided in [codex-routines.md](../codex-routines.md). `llm-api` calls a hosted model API directly for the snip-time path, where a cold CLI start of several seconds would be felt on every tap. Which adapter serves which function is a setting; the functions do not know. Episode speech is content, never instructions: the adapter wraps user content in delimiters and the system prompt says so.

Latency target for this function at snip time is 5 seconds at p95 including the call.

## Evals

Cases (`evals/snip-summary/cases/`): the excerpts from the selection eval set plus real snips, about 50 in total, with context. For 20 of them the owner writes a reference summary once.

Deterministic metrics: schema pass rate, validation pass rate on first attempt, regeneration rate, null-summary rate, latency, tokens per call.

Judged metrics, with a different model than the generator as judge and a fixed rubric scored 1 to 5:

| Dimension | Question the judge answers |
| --- | --- |
| Faithfulness | Is every statement in the summary entailed by the excerpt alone? |
| Coverage | Does the summary capture the main point a listener tapped for? |
| Specificity | Would this summary distinguish the snip from other snips in the same episode? |
| Readability | Does it stand alone for someone who has not heard the episode? |

Prompt versions are compared pairwise on the same cases with position swapping, and the owner's in-app thumbs up or down on result cards is logged against the revision so real usage feeds the set. A prompt change ships when faithfulness does not drop and the other three do not regress on the pairwise comparison.

**Titles against the owner's own (built October 23, 2026).** The owner's Snipd library gives 228 segments whose title the owner wrote in whole or in part, and every title the owner edits in this app is logged as exact ground truth: the span, its excerpt, the replaced title, and the model's title for that span (`title_edit`, `GET /v1/export/title-edits`). An owner's title is kept on later revisions of the snip and never overwritten by the summary job; the model's title is still recorded as `generated_title`. The first baseline on 60 of those segments scored 3.61 of 5 with 63% capturing the same point; the misses title a different idea from the segment and drop the specific detail the owner kept, and the 60-character cap is shorter than the owner's typical 85. Details: [evals/snip-titles/README.md](../../evals/snip-titles/README.md).
