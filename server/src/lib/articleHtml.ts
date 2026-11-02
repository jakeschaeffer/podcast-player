/**
 * Turn a publisher's article HTML (a text-feed item or a newsletter email) into the text the podcast reads:
 * the preamble after the greeting, the section headings, the body paragraphs with quoted blocks and speaker
 * prefixes preserved, and nothing from the mail chrome before or after. Pure; tested on a synthetic fixture.
 */
import { DomHandler, Parser } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";

export type Paragraph = {
  text: string;
  /** Speaker name when the paragraph starts with "Name:" or the host's implicit turn in an interview; null otherwise. */
  speaker: string | null;
  /** Inside a blockquote: text the author is quoting (and, on the podcast, reading aloud). */
  quote: boolean;
  /** Index into `sections`, or -1 for the preamble. */
  section: number;
};

export type Section = { title: string; first_paragraph: number };

export type ArticleText = {
  title: string;
  kind: "update" | "article" | "interview" | "other";
  /** Episode date from the subject's suffix, as YYYY-MM-DD, when present. */
  date: string | null;
  paragraphs: Paragraph[];
  sections: Section[];
  /** Paragraph texts joined by blank lines: the string handed to forced alignment. */
  text: string;
  word_count: number;
};

const BLOCK_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "blockquote", "div", "td", "tr", "table", "br"]);
const SKIP_TAGS = new Set(["style", "script", "head", "title", "img"]);

const START_MARKER = /^on to the (update|conversation|interview|article|essay)\b/i;
const END_MARKERS = [
  /^this .{0,60}?(will be|is also) available as a podcast/i,
  /^the (stratechery |daily )?update is intended for a single recipient/i,
  /^thanks for being a (subscriber|supporter)/i,
  /^listen to this (update|article|interview|episode) and other/i,
  /^subscription information/i,
  /^add to your podcast player:/i,
];
/** In the article feed, a one-line summary and this line precede the body. */
const LISTEN_LINE = /^listen to this (update|article|interview|episode) in your podcast player/i;
const DROP_IN_BODY = [/^this interview (is|has been) lightly edited/i, /^topics:$/i];
const SPEAKER_PREFIX = /^((?:[A-Z][\w.'’-]*\s){0,3}[A-Z][\w.'’-]*|[A-Z]{2,3}):\s+(.+)$/s;

/** Parse the subject line: title, kind, and date from a suffix like "(Stratechery Update 10-21-2026)". */
export function parseSubject(subject: string): { title: string; kind: ArticleText["kind"]; date: string | null } {
  const m = subject.match(/^(.*?)\s*\(((?:Stratechery|Daily)\s+)?(Update|Article|Interview|Essay)(?:\s+Interview)?\s+(\d{1,2})-(\d{1,2})-(\d{4})\)\s*$/i);
  if (!m) {
    const weekly = subject.match(/^(.*?)\s*\(This Week in Stratechery\)\s*$/i);
    return { title: (weekly ? weekly[1]! : subject).trim(), kind: "other", date: null };
  }
  const kindWord = m[3]!.toLowerCase();
  const kind: ArticleText["kind"] = kindWord === "update" ? "update" : kindWord === "article" || kindWord === "essay" ? "article" : "interview";
  const date = `${m[6]}-${m[4]!.padStart(2, "0")}-${m[5]!.padStart(2, "0")}`;
  return { title: m[1]!.trim(), kind, date };
}

type Block = { tag: string; text: string; quote: boolean };

/** Flatten the HTML into ordered text blocks, each with its tag and whether it sits inside a blockquote. */
export function htmlBlocks(html: string): Block[] {
  const handler = new DomHandler();
  const parser = new Parser(handler, { decodeEntities: true });
  parser.write(html);
  parser.end();
  const blocks: Block[] = [];
  let buffer: string[] = [];
  let bufferTag = "p";
  let quoteDepth = 0;
  const flush = () => {
    const text = buffer.join("").replace(/\s+/g, " ").trim();
    if (text.length > 0) blocks.push({ tag: bufferTag, text, quote: quoteDepth > 0 });
    buffer = [];
  };
  const walk = (nodes: ChildNode[]) => {
    for (const node of nodes) {
      if (node.type === "text") {
        buffer.push(node.data);
      } else if (node.type === "tag" || node.type === "script" || node.type === "style") {
        const el = node as Element;
        const tag = el.name.toLowerCase();
        if (SKIP_TAGS.has(tag)) continue;
        if (BLOCK_TAGS.has(tag)) {
          flush();
          if (tag === "blockquote") quoteDepth++;
          const prevTag = bufferTag;
          bufferTag = /^h[1-6]$/.test(tag) || tag === "p" || tag === "li" ? tag : prevTag === "p" || /^h[1-6]$/.test(prevTag) ? prevTag : "p";
          if (/^h[1-6]$/.test(tag) || tag === "p" || tag === "li") bufferTag = tag;
          walk(el.children);
          flush();
          if (tag === "blockquote") quoteDepth--;
          bufferTag = "p";
        } else {
          walk(el.children);
        }
      }
    }
  };
  walk(handler.dom);
  flush();
  return blocks;
}

/** Split "Greg Peters: text" into a speaker and the remainder; initials are resolved against names seen earlier. */
function splitSpeaker(text: string, seen: Map<string, string>): { speaker: string | null; text: string } {
  const m = text.match(SPEAKER_PREFIX);
  if (!m) return { speaker: null, text };
  const label = m[1]!.trim();
  const rest = m[2]!.trim();
  if (rest.length === 0) return { speaker: null, text };
  if (/^[A-Z]{2,3}$/.test(label)) {
    const full = seen.get(label);
    return { speaker: full ?? label, text: rest };
  }
  const initials = label.split(/\s+/).map((w) => w[0]!).join("");
  if (!seen.has(initials)) seen.set(initials, label);
  return { speaker: label, text: rest };
}

/** Email form: the kind and date come from the subject line. */
export function extractArticleFromEmail(html: string, subject: string): ArticleText {
  return extractArticle(html, parseSubject(subject));
}

/** Guess the kind of a feed item from its title and body when no subject suffix says. */
export function inferKind(title: string, blocks: Block[]): ArticleText["kind"] {
  if (/^(an interview with|a conversation with)/i.test(title)) return "interview";
  const paras = blocks.filter((b) => b.tag === "p");
  const prefixed = paras.filter((b) => SPEAKER_PREFIX.test(b.text)).length;
  if (paras.length >= 20 && prefixed / paras.length > 0.2) return "interview";
  if (blocks.slice(0, 6).some((b) => /this week in stratechery/i.test(b.text))) return "other";
  if (blocks.some((b) => START_MARKER.test(b.text))) return "update";
  return "article";
}

/**
 * Generic form: `kind` may be omitted for feed items and is then inferred; `date` is informational.
 * Handles both the email layout (h1 title, greeting, footer, subscription table) and the article-feed layout
 * (summary line, "Listen to this Update" line, body, "Add to your podcast player" footer).
 */
export function extractArticle(html: string, meta: { title: string; kind?: ArticleText["kind"]; date?: string | null }): ArticleText {
  const title = meta.title;
  const date = meta.date ?? null;
  const blocks = htmlBlocks(html);
  const kind = meta.kind ?? inferKind(title, blocks);

  // Start after the h1 title block (email) or after the "Listen to this…" line (feed); skip the greeting; stop at the first footer marker.
  let i = blocks.findIndex((b) => b.tag === "h1");
  if (i < 0) {
    const listen = blocks.slice(0, 4).findIndex((b) => LISTEN_LINE.test(b.text));
    i = listen >= 0 ? listen + 1 : 0;
  } else i++;
  const body: Block[] = [];
  for (; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (END_MARKERS.some((re) => re.test(b.text))) break;
    if (/^good (morning|afternoon|evening)[,!]?$/i.test(b.text)) continue;
    if (DROP_IN_BODY.some((re) => re.test(b.text))) continue;
    body.push(b);
  }
  // In interviews a "Topics:" paragraph is followed by a pipe-separated list; drop that list too.
  const topicsIdx = body.findIndex((b) => /\|/.test(b.text) && b.text.split("|").length >= 3 && b.text.split(/\s+/).length < 60 && b.tag === "p");
  if (kind === "interview" && topicsIdx >= 0 && topicsIdx < 6) body.splice(topicsIdx, 1);

  const paragraphs: Paragraph[] = [];
  const sections: Section[] = [];
  const seen = new Map<string, string>();
  let section = -1;
  let inInterviewBody = kind !== "interview";
  for (const b of body) {
    if (/^h[2-6]$/.test(b.tag)) {
      if (kind === "interview" && b.tag === "h3" && !inInterviewBody) {
        inInterviewBody = true; // the interview's own h3 repeats the title; it is not a chapter
        continue;
      }
      sections.push({ title: b.text.replace(/:$/, ""), first_paragraph: paragraphs.length });
      section = sections.length - 1;
      continue;
    }
    if (START_MARKER.test(b.text)) {
      paragraphs.push({ text: b.text, speaker: null, quote: b.quote, section });
      continue;
    }
    const { speaker, text } = splitSpeaker(b.text, seen);
    // Interview convention: the guest's turns carry a prefix; the host's turns carry none.
    let who = speaker;
    if (kind === "interview" && inInterviewBody && !b.quote) {
      if (speaker === null && seen.size > 0) who = "Host";
    }
    paragraphs.push({ text, speaker: who, quote: b.quote, section });
  }
  const text = paragraphs.map((p) => p.text).join("\n\n");
  return { title, kind, date, paragraphs, sections, text, word_count: text.split(/\s+/).filter(Boolean).length };
}
