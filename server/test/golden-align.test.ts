/**
 * Golden cases for the two helpers ad detection stands on: `normalizeToken` (core/transcript/tokens.ts) and
 * `alignTokens` (core/transcript/align.ts). Neither carries a version of its own; this file's does, and a change to
 * either reference is a new file (contracts/golden/README.md). The Swift port (ios/Packages/SnipCore) replays it.
 * Inputs are invented.
 */
import { describe, expect, it } from "vitest";
import { alignTokens } from "../src/core/transcript/align.js";
import { normalizeToken } from "../src/core/transcript/tokens.js";
import { golden } from "./helpers/golden.js";
import { lcg } from "./helpers/transcript.js";

const ALIGN_GOLDEN_VERSION = "align_v1";

const tokenTexts = [
  "Hello,", "hello", "HELLO!", "don't", "don’t", "‘quoted’", "'tis", "rock'n'roll", "''", "'", "'a'", "a''b", "'''a", "a'''", "’a’b’", "O'Brien's",
  "ACME.com", "acme-dot-com", "50%", "1,000.50", "3rd", "x_y", "a-b", "a b", "  ", "", "$5", "#1", "e-mail", "(parenthetical)", "end.", "wait…", "“curly”", "¿Qué?",
  "naïve", "café", "é", "É", "straße", "ẞ", // sharp s, capital sharp s
  "İstanbul", "I", "ı", "THİS", // dotted capital I lowercases to i plus a combining dot; dotless i is not ASCII
  "K", "BACK", "Å", // Kelvin sign lowercases to k; Angstrom sign to a-ring
  "ſ", "muſic", // long s
  "ＡＢＣ", "１２", "٣", "²", "①", // full-width letters and digits, Arabic-Indic digit, superscript two, circled one
  "Σ", "ΟΣ", "ǅ", "ﬁ", "＇", "`", "′", "ʼ", "‛", // sigma, final sigma, titlecase dz, fi ligature, apostrophe look-alikes
  "🎵", "a🎵b", "👍🏽", "日本語", "Ȧ", "a​b", "a b", "a­b",
];

type AlignInput = { name: string; ref: string[]; hyp: string[]; band?: number };

const t = (s: string) => (s === "" ? [] : s.split(" "));
const numbered = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i}`);

/** Two word sequences that follow each other with substitutions, deletions and insertions sprinkled in. */
function noisy(seed: number, n: number): { ref: string[]; hyp: string[] } {
  const r = lcg(seed);
  const vocab = ["the", "team", "shipped", "a", "new", "version", "and", "it", "worked", "well"];
  const ref = Array.from({ length: n }, () => vocab[Math.floor(r() * vocab.length)]!);
  const hyp: string[] = [];
  for (const w of ref) {
    const roll = r();
    if (roll < 0.1) continue;
    hyp.push(roll < 0.2 ? "um" : w);
    if (roll > 0.9) hyp.push(vocab[Math.floor(r() * vocab.length)]!);
  }
  return { ref, hyp };
}

const alignInputs: AlignInput[] = [
  { name: "both empty", ref: [], hyp: [] },
  { name: "empty reference", ref: [], hyp: t("a b c") },
  { name: "empty hypothesis", ref: t("a b c"), hyp: [] },
  { name: "identical", ref: t("the quick brown fox"), hyp: t("the quick brown fox") },
  { name: "one word, same", ref: ["a"], hyp: ["a"] },
  { name: "one word, different", ref: ["a"], hyp: ["b"] },
  { name: "one substitution", ref: t("the quick brown fox"), hyp: t("the quick red fox") },
  { name: "one deletion", ref: t("the quick brown fox"), hyp: t("the quick fox") },
  { name: "one insertion", ref: t("the quick fox"), hyp: t("the quick brown fox") },
  { name: "deletion at the start", ref: t("a b c d"), hyp: t("b c d") },
  { name: "deletion at the end", ref: t("a b c d"), hyp: t("a b c") },
  { name: "insertion at the start", ref: t("b c d"), hyp: t("a b c d") },
  { name: "insertion at the end", ref: t("a b c"), hyp: t("a b c d") },
  { name: "nothing in common", ref: t("a b c"), hyp: t("x y z") },
  { name: "nothing in common, longer hypothesis", ref: t("a b"), hyp: t("v w x y z") },
  { name: "nothing in common, longer reference", ref: t("a b c d e"), hyp: t("x y") },
  { name: "swapped pair", ref: t("a b"), hyp: t("b a") },
  { name: "repeated word, shorter hypothesis", ref: t("a a"), hyp: t("a") },
  { name: "repeated word, longer hypothesis", ref: t("a"), hyp: t("a a") },
  { name: "repeats on both sides", ref: t("a a a b a a"), hyp: t("a a b a a a") },
  { name: "a passage the reference lacks", ref: t("one two three four five six"), hyp: t("one two three ad ad ad ad ad four five six") },
  { name: "a passage the hypothesis lacks", ref: t("one two three cut cut cut cut four five six"), hyp: t("one two three four five six") },
  { name: "a shared word inside an inserted passage", ref: t("we tested the plan and it held"), hyp: t("we tested the plan try the offer and save now and it held") },
  { name: "ties choose substitution over a gap", ref: t("a b c"), hyp: t("a x c") },
  { name: "a swapped pair inside", ref: t("a b c d"), hyp: t("a c b d") },
  // One sequence is the other shifted by a word: deleting and inserting cost the same at the last cell, and the
  // deletion is taken there, so it comes last in the script.
  { name: "ties choose deletion over insertion", ref: t("a b a"), hyp: t("b a b") },
  { name: "ties choose deletion over insertion, the other way round", ref: t("b a b"), hyp: t("a b a") },
  { name: "ties choose deletion over insertion, longer", ref: t("a b a b a b a"), hyp: t("b a b a b a b") },
  { name: "ties choose deletion over insertion, narrow band", ref: t("a c a"), hyp: t("c a c"), band: 1 },
  { name: "case and accents are the caller's to remove", ref: t("Café cafe CAFE"), hyp: t("cafe cafe cafe") },
  { name: "composed and decomposed forms differ", ref: ["josé", "été", "🎉"], hyp: ["josé", "été", "🎉"] },
  { name: "empty strings are tokens too", ref: ["", "a", ""], hyp: ["a", "", ""] },
  { name: "noisy, 120 words", ...noisy(7, 120) },
  { name: "noisy, 300 words", ...noisy(21, 300) },
  { name: "noisy, narrow band", ...noisy(7, 120), band: 5 },
  { name: "band of zero, equal lengths", ref: t("a b c d e"), hyp: t("a x c d y"), band: 0 },
  { name: "band of zero, longer hypothesis", ref: t("a b c"), hyp: t("a b x x c"), band: 0 },
  { name: "band of zero, longer reference", ref: t("a b x x c"), hyp: t("a b c"), band: 0 },
  { name: "band of zero, half as long", ref: t("a b c d"), hyp: t("a c"), band: 0 },
  { name: "band of one, hypothesis five times longer", ref: t("a b"), hyp: t("a a a a a b b b b b"), band: 1 },
  { name: "band of one, reference five times longer", ref: t("a a a a a b b b b b"), hyp: t("a b"), band: 1 },
  { name: "band of two, a late insertion run", ref: t("a b c"), hyp: t("a b x x x x x x x x x x x x x x x x x c"), band: 2 },
  { name: "band wider than both", ref: t("a b c"), hyp: t("c b a"), band: 50 },
  // The default band is 600: an inserted run longer than that leaves the band, and the answer shows it.
  { name: "default band, 700 extra words in the hypothesis", ref: t("start middle end"), hyp: ["start", ...numbered(350, "x"), "middle", ...numbered(350, "y"), "end"] },
  { name: "default band, 700 extra words in the reference", ref: ["start", ...numbered(350, "x"), "middle", ...numbered(350, "y"), "end"], hyp: t("start middle end") },
  { name: "default band, an insertion of 650 at the start", ref: numbered(40, "w"), hyp: [...numbered(650, "x"), ...numbered(40, "w")] },
];

// Every small shape with a band of zero or one: where the scaled diagonal rounds, and what falls outside it.
for (const band of [0, 1]) {
  for (let n = 0; n <= 5; n++) {
    for (let m = 0; m <= 5; m++) {
      alignInputs.push({ name: `shape ${n} by ${m}, band ${band}`, ref: Array.from({ length: n }, (_, i) => `t${i % 3}`), hyp: Array.from({ length: m }, (_, j) => `t${j % 2}`), band });
    }
  }
}

/** Every code point that survives `normalizeToken` on its own, with what it becomes. */
function survivingCodePoints(): [number, string][] {
  const out: [number, string][] = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const token = normalizeToken(String.fromCodePoint(cp));
    if (token !== "") out.push([cp, token]);
  }
  return out;
}

/** Every code point that becomes an apostrophe between two letters. */
function apostropheCodePoints(): number[] {
  const out: number[] = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if (normalizeToken(`a${String.fromCodePoint(cp)}b`) === "a'b") out.push(cp);
  }
  return out;
}

function buildCases() {
  return {
    normalize_token: tokenTexts.map((text) => ({ text, expect: normalizeToken(text) })),
    surviving_code_points: survivingCodePoints(),
    apostrophe_code_points: apostropheCodePoints(),
    align_tokens: alignInputs.map(({ name, ref, hyp, band }) => (band === undefined ? { name, ref, hyp, expect: alignTokens(ref, hyp) } : { name, ref, hyp, band, expect: alignTokens(ref, hyp, band) })),
  };
}

describe("align_v1 golden cases", () => {
  const cases = buildCases();
  const token = Object.fromEntries(cases.normalize_token.map((c) => [c.text, c.expect]));
  const aligned = Object.fromEntries(cases.align_tokens.map((c) => [c.name, c.expect]));

  it("behave as intended", () => {
    expect(token["don’t"]).toBe("don't");
    expect(token["‘quoted’"]).toBe("quoted");
    expect(token["ACME.com"]).toBe("acmecom");
    expect(token["naïve"]).toBe("nave");
    expect(token["İstanbul"]).toBe("istanbul");
    expect(token["BACK"]).toBe("back");
    expect(token["muſic"]).toBe("muic");
    expect(token["🎵"]).toBe("");
    // a-z and 0-9 in either case, plus the two capitals whose lowercase holds an ASCII letter.
    expect(cases.surviving_code_points).toHaveLength(64);
    expect(cases.surviving_code_points.filter(([cp]) => cp > 127)).toEqual([[0x130, "i"], [0x212a, "k"]]);
    expect(cases.apostrophe_code_points).toEqual([0x27, 0x2018, 0x2019]);

    expect(aligned.identical).toEqual({ ops: ["match", "match", "match", "match"], pairs: [[0, 0], [1, 1], [2, 2], [3, 3]], sub: 0, del: 0, ins: 0 });
    expect(aligned["one substitution"]).toMatchObject({ sub: 1, del: 0, ins: 0 });
    expect(aligned["one deletion"]).toMatchObject({ sub: 0, del: 1, ins: 0 });
    expect(aligned["one insertion"]).toMatchObject({ sub: 0, del: 0, ins: 1 });
    expect(aligned["a passage the reference lacks"]).toMatchObject({ sub: 0, del: 0, ins: 5 });
    expect(aligned["ties choose substitution over a gap"]!.ops).toEqual(["match", "sub", "match"]);
    expect(aligned["ties choose deletion over insertion"]!.ops).toEqual(["ins", "match", "match", "del"]);
    expect(aligned["composed and decomposed forms differ"]).toMatchObject({ sub: 2, pairs: [[2, 2]] });
    // Every answer consumes both sequences exactly, in or out of the band.
    for (const c of cases.align_tokens) {
      const consumed = (which: string[]) => c.expect.ops.filter((op) => which.includes(op)).length;
      expect(consumed(["match", "sub", "del"])).toBe(c.ref.length);
      expect(consumed(["match", "sub", "ins"])).toBe(c.hyp.length);
      expect(consumed(["match"])).toBe(c.expect.pairs.length);
    }
    // Past the band the aligner still answers, but worse: the first of the 40 shared words go unmatched.
    expect(aligned["default band, an insertion of 650 at the start"]!.pairs.length).toBeLessThan(40);
  });

  it("match the committed file", () => {
    const file = {
      family: "alignment",
      version: ALIGN_GOLDEN_VERSION,
      reference: ["server/src/core/transcript/tokens.ts", "server/src/core/transcript/align.ts"],
      default_band: 600,
      ...cases,
    };
    expect(golden(`transcript/${ALIGN_GOLDEN_VERSION}.json`, file)).toEqual(JSON.parse(JSON.stringify(file)));
  });
});
