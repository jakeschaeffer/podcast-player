import { describe, expect, it } from "vitest";
import { showNotesChapters, showNotesLines, timestampLine } from "./showNotes.js";

const HOUR = 3_600_000;
const titles = (html: string, duration = HOUR) => showNotesChapters(html, duration)?.map((p) => [p.start_ms / 1000, p.title]) ?? null;

describe("showNotesChapters: lists it believes", () => {
  it("reads <br>-separated lines with parenthesised times and dash separators", () => {
    const html = `<p>Thanks to our sponsors.<br />
– <b>Acme</b>: <a href="https://acme.test/show">https://acme.test/show</a></p>
<p><b>OUTLINE:</b><br />
Here are the timestamps for the episode.<br />
(00:00) – Introduction<br />
(07:37) – The first topic<br />
(1:01:10) – A later topic &amp; more<br />
(1:10:02) – Hope</p>`;
    expect(titles(html, 2 * HOUR)).toEqual([[0, "Introduction"], [457, "The first topic"], [3670, "A later topic & more"], [4202, "Hope"]]);
  });

  it("reads list items and paragraphs in the common formats, bullets and brackets included", () => {
    const html = `<p>Timestamps</p><ul>
<li>00:00 Intro</li><li>[05:10] Why we started</li><li>(12:34) Pricing, take two</li><li>1:02:03 - The long tail</li></ul>
<p>Links</p><ul><li><a href="https://x.test">A link</a></li></ul>`;
    expect(titles(html, 2 * HOUR)).toEqual([[0, "Intro"], [310, "Why we started"], [754, "Pricing, take two"], [3723, "The long tail"]]);
    const paragraphs = `<p>Chapters</p><p>* [00:00:01] Introductions</p><p>* [00:01:28] Founding story</p><p>* [00:03:50] "Minimum viable agents"</p>`;
    expect(titles(paragraphs)).toEqual([[1, "Introductions"], [88, "Founding story"], [230, '"Minimum viable agents"']]);
  });

  it("finds the list after the credits, keeps the end of a range out of the title, and stops at the next paragraph", () => {
    const html = `A story about prices.<br /><br />Our director is A. Person.<br /><br />(0:00) Introduction<br />(02:29 – 06:48) Prices and pay<br />(06:49) A court ruling<br />(10:25) A new prosecutor<br /><br />See example.test for privacy information.`;
    expect(titles(html, 841_000)).toEqual([[0, "Introduction"], [149, "Prices and pay"], [409, "A court ruling"], [625, "A new prosecutor"]]);
  });

  it("splits a list whose line breaks were lost, and lets a bulleted sentence sit under each entry", () => {
    expect(titles(`<p>00:00 Hello and guests00:22 The launch01:41 How it works05:39 The training recipe</p>`)).toEqual([
      [0, "Hello and guests"], [22, "The launch"], [101, "How it works"], [339, "The training recipe"],
    ]);
    const described = `<p>00:00 The idea</p><p>* The guest introduces the idea.</p><p>04:10 Where it came from</p><p>* Early years.</p><p>09:30 What is next</p><p>* Plans.</p>`;
    expect(titles(described)).toEqual([[0, "The idea"], [250, "Where it came from"], [570, "What is next"]]);
  });

  it("prefers the table of contents over a timestamped transcript pasted below it", () => {
    const transcript = Array.from({ length: 6 }, (_, i) => `<p><strong>${i * 1.5 | 0}:${i % 2 ? "30" : "00"}</strong> ${"So this is what a transcript paragraph sounds like when somebody talks for a while about a thing. ".repeat(3)}</p>`).join("");
    const html = `<p>Timestamps</p><p>* 0:00 What we do</p><p>* 1:25 From the old job to this one</p><p>* 4:19 Founding</p><p>Transcript</p>${transcript}`;
    expect(titles(html)).toEqual([[0, "What we do"], [85, "From the old job to this one"], [259, "Founding"]]);
  });

  it("drops entries just past the end of a slightly shorter recording, and allows a late first entry up to three minutes", () => {
    expect(titles(`<p>00:00 Ay</p><p>10:00 Bee</p><p>20:00 Sea</p><p>30:30 Dee</p>`, 30 * 60_000)).toEqual([[0, "Ay"], [600, "Bee"], [1200, "Sea"]]);
    expect(titles(`<p>02:27 Intros</p><p>10:00 Bee</p><p>20:00 Sea</p>`)).toEqual([[147, "Intros"], [600, "Bee"], [1200, "Sea"]]);
  });
});

describe("showNotesChapters: lists it rejects", () => {
  it("a single timestamp in prose, or two", () => {
    expect(titles(`<p>If you want the details, jump to 15:55 in the podcast.</p><p>00:00 Intro</p><p>Then 31:10 has the demo.</p>`)).toBeNull();
    expect(titles(`<p>00:00 Intro</p><p>10:00 Demo</p>`)).toBeNull();
  });

  it("times out of order", () => {
    expect(titles(`<p>00:00 Intro</p><p>13:01 Search</p><p>1:14:48 Platform</p><p>21:17 Chemistry</p>`)).toBeNull();
    expect(titles(`<p>00:00 Intro</p><p>05:00 Same</p><p>05:00 Again</p>`)).toBeNull();
  });

  it("clock times of day", () => {
    expect(titles(`<p>Schedule</p><p>2:30pm Doors open</p><p>3:00pm Keynote</p><p>4:15pm Panel</p>`)).toBeNull();
    expect(titles(`<p>2:30 pm Doors open</p><p>3:00 p.m. Keynote</p><p>4:15 PM Panel</p>`)).toBeNull();
    expect(timestampLine("12:345 is not a time")).toBeNull();
  });

  it("sponsor and promo-code lines", () => {
    const html = `<p>Sponsors:</p><ul><li>Acme: use code SHOW at acme.test, offer ends 11:59 PM</li><li>Widget: code 10:10OFF for 10% off</li><li>Gadget: 20% off before 12:00 tomorrow</li></ul>`;
    expect(titles(html)).toBeNull();
  });

  it("a list that starts well into the episode, or runs well past its end", () => {
    expect(titles(`<p>10:00 A topic</p><p>20:00 Another</p><p>30:00 A third</p>`)).toBeNull();
    expect(titles(`<p>00:00 Ay</p><p>40:00 Bee</p><p>1:20:00 Sea</p>`, HOUR)).toBeNull();
  });

  it("garbage titles: a bare link, punctuation, or a transcript paragraph", () => {
    expect(titles(`<p>00:00 Intro</p><p>05:00 https://example.test/a</p><p>10:00 Outro</p>`)).toBeNull();
    expect(titles(`<p>00:00 Intro</p><p>05:00 ---</p><p>10:00 Outro</p>`)).toBeNull();
    expect(titles(`<p>00:00 Intro</p><p>05:00 ${"word ".repeat(40)}</p><p>10:00 Outro</p>`)).toBeNull();
  });

  it("a transcript whose short lines are each timestamped", () => {
    const html = Array.from({ length: 30 }, (_, i) => `<p>[00:00:${String(i * 2).padStart(2, "0")}] Host: Yeah.</p>`).join("");
    expect(titles(html)).toBeNull();
  });

  it("nothing at all", () => {
    expect(showNotesChapters(null, HOUR)).toBeNull();
    expect(showNotesChapters("<p>Just prose.</p>", HOUR)).toBeNull();
  });
});

describe("showNotesLines", () => {
  it("splits at blocks and line breaks, decodes entities, and keeps plain-text newlines", () => {
    expect(showNotesLines(`<p>One &amp; two<br>three</p><ul><li>four</li></ul>five\nsix`)).toEqual(["One & two", "three", "four", "five", "six"]);
  });
});
