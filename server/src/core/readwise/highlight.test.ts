import { describe, expect, it } from "vitest";
import { highlightText, READWISE_LIMITS, readwiseHighlight, readwisePatch, type ReadwiseSnip } from "./highlight.js";

const SNIP: ReadwiseSnip = {
  title: "Build a semantic catalog",
  summary: "Enterprises keep data in thousands of databases.\nA catalog maps which tables hold what.",
  excerpt: "Most organizations have thousands of databases. This is the knowledge catalog.",
  turns: [
    { name: "Thomas Kurian", text: "Most organizations have thousands of databases." },
    { name: "Ben Thompson", text: "This is the knowledge catalog." },
  ],
  note: null,
  episode_title: "An Interview With Google Cloud CEO Thomas Kurian",
  show_title: "Stratechery",
  image_url: "https://img.example/cover.jpg",
  source_url: "https://stratechery.com/2026/kurian",
  start_ms: 754_900,
  captured_at: Date.UTC(2026, 10, 10, 12, 0, 0),
  share_url: "https://snip.example/s/abc",
};

describe("readwiseHighlight", () => {
  it("lays a snip out as the Snipd highlights already in Readwise: title, summary lines, then the transcript by speaker", () => {
    expect(highlightText(SNIP)).toBe(
      [
        "Build a semantic catalog",
        "Enterprises keep data in thousands of databases.",
        "A catalog maps which tables hold what.",
        "",
        "Transcript:",
        "Thomas Kurian",
        "Most organizations have thousands of databases.",
        "",
        "Ben Thompson",
        "This is the knowledge catalog.",
      ].join("\n"),
    );
  });

  it("files it as a podcast under the episode and show, at its start, linked to the page that plays it", () => {
    expect(readwiseHighlight(SNIP)).toMatchObject({
      title: SNIP.episode_title,
      author: "Stratechery",
      category: "podcasts",
      source_type: "snip_podcasts",
      location: 754,
      location_type: "time_offset",
      highlighted_at: "2026-11-10T12:00:00.000Z",
      highlight_url: "https://snip.example/s/abc",
      source_url: SNIP.source_url,
      image_url: SNIP.image_url,
    });
    expect(readwiseHighlight(SNIP)).not.toHaveProperty("note");
  });

  it("puts the owner's note in the note, and a patch clears a note that was removed", () => {
    expect(readwiseHighlight({ ...SNIP, note: "  ask about egress  " }).note).toBe("ask about egress");
    expect(readwisePatch(readwiseHighlight(SNIP))).toEqual({ text: highlightText(SNIP), note: "", location: 754, url: SNIP.share_url });
  });

  it("shows unnamed text as one block, and a snip without a transcript or summary as its title", () => {
    expect(highlightText({ ...SNIP, summary: null, turns: null })).toBe(`Build a semantic catalog\n\nTranscript:\n${SNIP.excerpt}`);
    expect(highlightText({ ...SNIP, turns: [{ name: null, text: "Just one voice." }] })).toMatch(/Transcript:\nJust one voice\.$/);
    expect(highlightText({ ...SNIP, summary: null, turns: null, excerpt: null })).toBe("Build a semantic catalog");
  });

  it("cuts a long transcript at a word to fit Readwise's limit, and leaves out links that are not web links", () => {
    const long = Array.from({ length: 3000 }, (_, i) => `word${i}`).join(" ");
    const text = highlightText({ ...SNIP, turns: null, excerpt: long });
    expect(text.length).toBeLessThanOrEqual(READWISE_LIMITS.text);
    expect(text).toMatch(/ word\d+…$/);
    expect(text.startsWith("Build a semantic catalog\n")).toBe(true);
    const h = readwiseHighlight({ ...SNIP, image_url: "data:image/png;base64,xx", source_url: null, show_title: null });
    expect(h).not.toHaveProperty("image_url");
    expect(h).not.toHaveProperty("source_url");
    expect(h).not.toHaveProperty("author");
  });
});
