import { describe, expect, it } from "vitest";
import { extractArticle, extractArticleFromEmail, parseSubject } from "./articleHtml.js";

const UPDATE = `<html><body>
<div style="display:none">A solid business, which is exactly the problem.</div>
<table><tr><td><a href="https://x.test/view?access_token=secret">View in browser</a> | <a href="#">Listen in your podcast player</a></td></tr></table>
<h1>Netflix Earnings, Business or Franchise, Disney’s Deal <span>Wednesday, October 21, 2026</span></h1>
<p>Good morning,</p>
<p>On this week’s episode of <a href="#">Sharp China</a>, Bill and Andrew discuss the summit.</p>
<p>On to the Update:</p>
<h3>Netflix Earnings</h3>
<p>From the <a href="#">Wall Street Journal</a>:</p>
<blockquote><p>Netflix reported its slowest revenue growth in years.</p><p>Greg Peters: I’ll pick up this one and start with engagement.</p></blockquote>
<p>I thought these earnings were notable for three reasons.</p>
<h3>Business or Franchise</h3>
<p>Netflix’s plan is, in so many words, to do better.</p>
<p>This Update will be available as a podcast later today. To receive it, add the feed.</p>
<p>The Stratechery Update is intended for a single recipient.</p>
<p>Thanks for being a subscriber, and have a great day!</p>
<h4>Listen to this update and other Stratechery Plus content in your podcast player:</h4>
<table><tr><td>Subscription Information Member: Jake Email: jake@example.test</td></tr></table>
</body></html>`;

const INTERVIEW = `<html><body>
<h1>A Conversation With Ari Emanuel <span>Thursday, October 15, 2026</span></h1>
<p>Good morning,</p>
<p>This week’s Stratechery Interview ended up not being an interview.</p>
<p>On to the conversation:</p>
<h3>A Conversation With Ari Emanuel</h3>
<p>This interview is lightly edited for clarity and content.</p>
<p>Topics:</p>
<p>The State of Social | Roll the Calls | AI and Creativity</p>
<h4>The State of Social</h4>
<p>Ari Emanuel: Can I ask you one question?</p>
<p>Sure, go ahead.</p>
<p>AE: Patrick, yeah, who I love.</p>
<h4>Roll the Calls</h4>
<p>So the way advertising is going to work is different.</p>
<p>AE: Because it’s just directed at you.</p>
<p>This Daily Update Interview is also available as a podcast.</p>
<p>Thanks for being a supporter, and have a great day!</p>
</body></html>`;

describe("parseSubject", () => {
  it("reads title, kind, and date from the suffix", () => {
    expect(parseSubject("Netflix Earnings, Business or Franchise, Disney’s Deal (Stratechery Update 10-21-2026)")).toEqual({ title: "Netflix Earnings, Business or Franchise, Disney’s Deal", kind: "update", date: "2026-10-21" });
    expect(parseSubject("Do You Trust Apple? (Stratechery Article 10-19-2026)")).toMatchObject({ kind: "article", date: "2026-10-19" });
    expect(parseSubject("A Conversation With Ari Emanuel About Entertainment and AI (Stratechery Interview 10-15-2026)")).toMatchObject({ kind: "interview" });
    expect(parseSubject("Home At Last (This Week in Stratechery)")).toEqual({ title: "Home At Last", kind: "other", date: null });
    expect(parseSubject("942712 is your Stratechery access code")).toMatchObject({ kind: "other" });
  });
});

describe("extractArticleFromEmail on an Update", () => {
  const a = extractArticleFromEmail(UPDATE, "Netflix Earnings, Business or Franchise, Disney’s Deal (Stratechery Update 10-21-2026)");

  it("keeps the preamble the podcast reads and drops greeting, chrome, and footer", () => {
    expect(a.paragraphs[0]!.text).toBe("On this week’s episode of Sharp China, Bill and Andrew discuss the summit.");
    expect(a.text).not.toMatch(/Good morning|View in browser|access_token|Subscription Information|available as a podcast|single recipient|Thanks for being/);
    expect(a.text).toContain("On to the Update:");
  });

  it("records sections and marks quoted paragraphs with their speakers", () => {
    expect(a.sections.map((s) => s.title)).toEqual(["Netflix Earnings", "Business or Franchise"]);
    const quoted = a.paragraphs.filter((p) => p.quote);
    expect(quoted.map((p) => [p.speaker, p.text])).toEqual([
      [null, "Netflix reported its slowest revenue growth in years."],
      ["Greg Peters", "I’ll pick up this one and start with engagement."],
    ]);
    expect(a.paragraphs.find((p) => p.text.startsWith("I thought"))!.section).toBe(0);
    expect(a.paragraphs.find((p) => p.text.startsWith("Netflix’s plan"))!.section).toBe(1);
    expect(a.paragraphs[0]!.section).toBe(-1);
  });

  it("joins paragraphs with blank lines and counts words", () => {
    expect(a.text.split("\n\n").length).toBe(a.paragraphs.length);
    expect(a.word_count).toBe(a.text.split(/\s+/).length);
    expect(a.date).toBe("2026-10-21");
  });
});

describe("extractArticleFromEmail on an Interview", () => {
  const a = extractArticleFromEmail(INTERVIEW, "A Conversation With Ari Emanuel (Stratechery Interview 10-15-2026)");

  it("drops the edit note and topics list, uses h4 headings as sections, and attributes turns", () => {
    expect(a.sections.map((s) => s.title)).toEqual(["The State of Social", "Roll the Calls"]);
    expect(a.text).not.toMatch(/lightly edited|Topics:|State of Social \|/);
    const turns = a.paragraphs.filter((p) => p.section >= 0).map((p) => [p.speaker, p.text]);
    expect(turns).toEqual([
      ["Ari Emanuel", "Can I ask you one question?"],
      ["Host", "Sure, go ahead."],
      ["Ari Emanuel", "Patrick, yeah, who I love."],
      ["Host", "So the way advertising is going to work is different."],
      ["Ari Emanuel", "Because it’s just directed at you."],
    ]);
  });

  it("keeps the preamble unattributed", () => {
    expect(a.paragraphs[0]).toMatchObject({ speaker: null, section: -1 });
  });
});


const FEED_UPDATE = `<p>Netflix has a solid business, which is exactly the problem.</p>
<p><a href="#">Listen to this Update in your podcast player</a></p>
<p>Good morning,</p>
<p>On this week’s episode of Sharp China, Bill and Andrew discuss export controls.</p>
<p>On to the Update:</p>
<h3>Netflix Earnings</h3>
<p>Netflix reported its slowest revenue growth in years.</p>
<h3>Disney’s Deal</h3>
<p>All that noted, Netflix is still in a position of strength.</p>
<p>This Update will be available as a podcast later today.</p>
<p>The Stratechery Update is intended for a single recipient.</p>
<p>Thanks for being a subscriber, and have a great day!</p>
<p>Add to your podcast player: Stratechery | Sharp Tech | Dithering</p>`;

const FEED_ARTICLE = `<p>Apple has a lot of trust in terms of delivering integrated products.</p>
<p>Listen to this Update in your podcast player</p>
<p>On July 21, 1999, Steve Jobs did something remarkable.</p>
<blockquote><p>There is one more thing.</p></blockquote>
<p>The difference is that that was an Apple that was eager to race ahead.</p>
<p>Add to your podcast player: Stratechery | Sharp Tech</p>`;

describe("extractArticle on article-feed items", () => {
  it("skips the summary and listen lines, keeps the preamble, infers an Update, and stops at the footer", () => {
    const a = extractArticle(FEED_UPDATE, { title: "Netflix Earnings, Business or Franchise, Disney’s Deal" });
    expect(a.kind).toBe("update");
    expect(a.paragraphs[0]!.text).toMatch(/^On this week’s episode/);
    expect(a.sections.map((s) => s.title)).toEqual(["Netflix Earnings", "Disney’s Deal"]);
    expect(a.text).not.toMatch(/solid business|Listen to this|Good morning|available as a podcast|single recipient|Thanks for being|Add to your podcast player/);
  });

  it("infers an Article when there is no preamble marker and keeps quoted blocks", () => {
    const a = extractArticle(FEED_ARTICLE, { title: "Do You Trust Apple?" });
    expect(a.kind).toBe("article");
    expect(a.paragraphs[0]!.text).toMatch(/^On July 21, 1999/);
    expect(a.paragraphs.find((p) => p.quote)!.text).toBe("There is one more thing.");
    expect(a.text).not.toMatch(/Add to your podcast player|Listen to this/);
  });

  it("infers an Interview from the title", () => {
    expect(extractArticle(FEED_ARTICLE, { title: "An Interview with Someone About Things" }).kind).toBe("interview");
  });
});
