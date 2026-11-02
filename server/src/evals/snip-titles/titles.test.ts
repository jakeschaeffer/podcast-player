import { describe, expect, it } from "vitest";
import { guessTitleOrigin, sentences, titleCaseRatio } from "./origin.js";
import { toSentences, wordRecall } from "./run.js";

describe("guessTitleOrigin", () => {
  it("recognises Snipd's headlines", () => {
    for (const t of ["Pump Rules", "Ethereum vs. Celestia: A Comparison of Key Differences", "Is There a Single-Payer Health Care System?", "The Weight of the World"]) {
      expect(guessTitleOrigin(t).origin).toBe("generated");
    }
  });
  it("recognises the owner's own notes", () => {
    for (const t of ["Increase power output when optimizing for strength. Use cluster sets (5-20secs b/w reps).", "Notes on THC for sleep. Negative impacts on REM, and tolerance rebounds.", "Millenials are the true agentic generation.", "How to be a better GPT predictor"]) {
      expect(guessTitleOrigin(t).origin).toBe("manual");
    }
  });
  it("splits a Snipd headline from the note appended after it", () => {
    const g = guessTitleOrigin("Rollups as a Service. Using oracle rollups.");
    expect(g).toMatchObject({ origin: "appended", generated_part: "Rollups as a Service.", owner_part: "Using oracle rollups." });
    expect(guessTitleOrigin("The Popularity of Oral Testosterone Therapy, Pellet Implants, and Injectables (the fav)")).toMatchObject({ origin: "appended", owner_part: "(the fav)" });
  });
  it("treats placeholders as placeholders", () => {
    expect(guessTitleOrigin("3min Snip").origin).toBe("placeholder");
  });
  it("does not split sentences on vs. or e.g.", () => {
    expect(sentences("Ethereum vs. Celestia: Differences")).toHaveLength(1);
    expect(titleCaseRatio("Notes on THC for sleep")).toBeCloseTo(2 / 3);
  });
});

describe("title eval helpers", () => {
  it("turns speaker turns into numbered sentences", () => {
    const s = toSentences([{ speaker: "Host", text: "So what happened? Tell me." }, { speaker: "Guest", text: "We doubled revenue." }]);
    expect(s.map((x) => [x.id, x.speaker, x.text])).toEqual([[0, "Host", "So what happened?"], [1, "Host", "Tell me."], [2, "Guest", "We doubled revenue."]]);
  });
  it("measures how many of the owner's content words a title keeps", () => {
    expect(wordRecall("Use cluster sets for power", "Cluster sets build power")).toBeCloseTo(3 / 4); // use, cluster, set, power → 3 kept
    expect(wordRecall("Pump Rules", "Something else entirely")).toBe(0);
  });
});
