import { describe, expect, it } from "vitest";
import type { WordTuple } from "../transcript/types.js";
import { chapterKind, feedChapterPoints, firstWordAtOrAfter, jsonChapters, parseClock, parseNpt } from "./points.js";

describe("parseClock and parseNpt", () => {
  it("read show-notes clock times", () => {
    expect(parseClock("0:00")).toBe(0);
    expect(parseClock("12:34")).toBe(754_000);
    expect(parseClock("75:30")).toBe(4_530_000);
    expect(parseClock("1:02:03")).toBe(3_723_000);
    expect(parseClock("00:00:01")).toBe(1000);
    expect(parseClock("12:60")).toBeNull();
    expect(parseClock("1:60:00")).toBeNull();
    expect(parseClock("2:30pm")).toBeNull();
  });

  it("read Podlove normal play time", () => {
    expect(parseNpt("00:01:02.500")).toBe(62_500);
    expect(parseNpt("01:02")).toBe(62_000);
    expect(parseNpt("62.5")).toBe(62_500);
    expect(parseNpt("1:00:00")).toBe(3_600_000);
    expect(parseNpt("soon")).toBeNull();
  });
});

describe("jsonChapters", () => {
  it("reads a Podcasting 2.0 chapters file, skipping hidden and untitled entries, in time order", () => {
    const doc = {
      version: "1.2.0",
      chapters: [
        { startTime: 0, title: "Intro" },
        { startTime: 95.5, title: "  The   main topic " },
        { startTime: 60, title: "A picture", toc: false, img: "https://x.test/a.jpg" },
        { startTime: 300 },
        { startTime: 1800, title: "Listener mail", endTime: 2000 },
        { startTime: 1200, title: "Sponsor: Acme" },
      ],
    };
    expect(jsonChapters(doc)).toEqual([
      { start_ms: 0, title: "Intro" },
      { start_ms: 95_500, title: "The main topic" },
      { start_ms: 1_200_000, title: "Sponsor: Acme" },
      { start_ms: 1_800_000, title: "Listener mail" },
    ]);
  });

  it("returns null for anything that is not a usable chapters document", () => {
    expect(jsonChapters(null)).toBeNull();
    expect(jsonChapters({ chapters: "no" })).toBeNull();
    expect(jsonChapters({ chapters: [{ startTime: 0, title: "Only one" }] })).toBeNull();
    expect(jsonChapters({ chapters: [{ startTime: -5, title: "Bad" }, { startTime: "x", title: "Worse" }] })).toBeNull();
  });
});

describe("feedChapterPoints", () => {
  it("drops points at or past the end of the recording and needs two left", () => {
    const points = [{ start_ms: 0, title: "A" }, { start_ms: 50_000, title: "B" }, { start_ms: 100_000, title: "C" }];
    expect(feedChapterPoints(points, 100_000)).toEqual(points.slice(0, 2));
    expect(feedChapterPoints(points, 40_000)).toBeNull();
  });
});

describe("chapterKind", () => {
  it("labels sponsor reads, intros, and outros as the summary does", () => {
    expect(chapterKind("Sponsor: Acme")).toBe("ad");
    expect(chapterKind("Our sponsors")).toBe("ad");
    expect(chapterKind("Ad break")).toBe("ad");
    expect(chapterKind("Introduction")).toBe("intro");
    expect(chapterKind("Intros & background")).toBe("intro");
    expect(chapterKind("Outro")).toBe("outro");
    expect(chapterKind("Adaptive pricing")).toBe("content");
    expect(chapterKind("Why introductions matter")).toBe("content");
  });
});

describe("firstWordAtOrAfter", () => {
  const words: WordTuple[] = [[0, 300, "a"], [400, 700, "b"], [800, 1100, "c"], [1200, 1500, "d"]];
  it("finds the first word starting at or after a time", () => {
    expect(firstWordAtOrAfter(words, 0)).toBe(0);
    expect(firstWordAtOrAfter(words, 400)).toBe(1);
    expect(firstWordAtOrAfter(words, 401)).toBe(2); // mid-word: the next whole word
    expect(firstWordAtOrAfter(words, 5000)).toBe(4);
    expect(firstWordAtOrAfter([], 10)).toBe(0);
  });
});
