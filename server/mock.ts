/**
 * Demo mode. With no API key configured (or MOCK_AI=1) the backend still runs
 * the whole flow, but the "AI" is this file: a canned transcript and canned
 * replies. It lets anyone try the glasses experience in the simulator before
 * setting up keys, and it is what the automated end-to-end run uses.
 *
 * Nothing here is used once real keys are set.
 */
import type { RecordingPurpose } from "../shared/types.ts";
import type { CallOptions, LlmResult } from "./llm.ts";
import type { ArticleDraft, EditResult } from "./prompts.ts";
import { pcmMs } from "./stt.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DELAY = Number(process.env.MOCK_DELAY_MS ?? 1200);

/** What the pretend author says, with the stumbles a real recording has. */
const SCRIPT = [
  "So, um, I want to write about why I stopped keeping a to-do list.",
  "For about three years I kept one giant list, and it just, it just kept growing.",
  "At one point it had, like, four hundred items on it.",
  "And, you know, the problem wasn't that I was lazy.",
  "The problem was that the list never told me what mattered today.",
  "I tried the Eisenhower matrix, which I think President Eisenhower invented in 1954, and that didn't help either.",
  "What finally worked was really simple.",
  "Every morning I write down three things, on paper, and that's it.",
  "If something isn't one of the three, it waits.",
  "Uh, I've been doing that for a while now, and I get more done, and honestly I feel less guilty.",
];

export async function mockTranscribe(pcm: Uint8Array, hint: { purpose: RecordingPurpose; idx: number }): Promise<string> {
  await sleep(Math.min(DELAY, 600));
  if (hint.purpose === "instruction") return "Make the opening more direct.";
  if (hint.purpose === "answer") return "Um, about six months.";
  // The script is "spoken" briskly, so a ten-second demo take contains all of it.
  // A second slice carries on where the first stopped; past the end there is nothing more to say.
  const perSlice = Math.max(1, Math.ceil(pcmMs(pcm) / 800));
  return SCRIPT.slice(hint.idx * perSlice, (hint.idx + 1) * perSlice).join(" ");
}

const SOURCE = { title: "Time management: The Eisenhower Method (Wikipedia)", url: "https://en.wikipedia.org/wiki/Time_management" };

const between = (s: string, name: string) => new RegExp(`<${name}[^>]*>\\n?([\\s\\S]*?)\\n?</${name}>`).exec(s)?.[1]?.trim() ?? "";

function tidy(transcript: string): string {
  const cleaned = transcript
    .replace(/\b(so, )?(um|uh|er),?\s*/gi, "")
    .replace(/,?\s*\b(you know|like|I mean|honestly),/gi, "")
    .replace(/\b(\w+(?: \w+)?), \1\b/gi, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/(^|[.!?]\s+)([a-z])/g, (_m, lead: string, ch: string) => lead + ch.toUpperCase())
    .trim();
  // A new paragraph every three sentences keeps the material readable on the glasses.
  const sentences = cleaned.match(/[^.!?。！？]+[.!?。！？]+\s*/g) ?? [cleaned];
  const paragraphs: string[] = [];
  for (let i = 0; i < sentences.length; i += 3) paragraphs.push(sentences.slice(i, i + 3).join("").trim());
  return paragraphs.join("\n\n");
}

function draft(material: string): ArticleDraft {
  if (/to-do list/i.test(material)) {
    return {
      title: "Why I stopped keeping a to-do list",
      gist: "A giant to-do list never says what matters today. Three things on paper each morning does.",
      markdown: [
        "For about three years I kept one giant to-do list, and it only ever grew. At one point it had four hundred items on it.",
        "The problem wasn't that I was lazy. The list never told me what mattered today.",
        'I tried the Eisenhower matrix, <mark data-id="a1">which President Eisenhower invented in 1954</mark>, and that didn\'t help either. <mark data-id="a2">The matrix as people use it today was popularised by Stephen Covey in The 7 Habits of Highly Effective People, published in 1989.</mark>',
        "What finally worked was simple. Every morning I write down three things, on paper, and that's it. If something isn't one of the three, it waits.",
        'I\'ve been doing that <mark data-id="a3">for a while now</mark>. I get more done, and I feel less guilty.',
      ].join("\n\n"),
      annotations: [
        {
          id: "a1",
          kind: "diff",
          note: "Eisenhower described the idea in a 1954 speech; the matrix itself was drawn up later by others.",
          suggestion: "which is named after President Eisenhower, who described the idea in a 1954 speech",
          source_title: SOURCE.title,
          source_url: SOURCE.url,
        },
        { id: "a2", kind: "added", note: "Says where the matrix comes from.", suggestion: "", source_title: SOURCE.title, source_url: SOURCE.url },
        { id: "a3", kind: "ask", note: "How long have you been using the three-things list?", suggestion: "", source_title: "", source_url: "" },
      ],
    };
  }
  // Real transcription with a simulated writer: lay the material out as it is.
  const body = material.replace(/^## .*$/gm, "").trim();
  const first = body.split(/(?<=[.!?。！？])\s+/)[0] ?? body;
  return {
    title: first.replace(/[.!?。！？]+$/, "").slice(0, 60) || "Untitled",
    gist: body.replace(/\s+/g, " ").slice(0, 150),
    markdown: body,
    annotations: [],
  };
}

function edit(user: string): EditResult {
  const head = /<article title=("(?:[^"\\]|\\.)*") gist=("(?:[^"\\]|\\.)*")>/.exec(user);
  const title = head ? (JSON.parse(head[1]!) as string) : "";
  const gist = head ? (JSON.parse(head[2]!) as string) : "";
  const markdown = between(user, "article");
  const instruction = between(user, "instruction");
  const question = /<question mark="([\w-]+)">/.exec(user);
  if (question) {
    const answer = instruction.replace(/^(um|uh)[,\s]*/i, "").replace(/[.!?]+$/, "").trim();
    const worked = `for ${answer.charAt(0).toLowerCase()}${answer.slice(1)}`;
    return {
      title,
      gist,
      markdown: markdown.replace(new RegExp(`<mark data-id="${question[1]}">[\\s\\S]*?</mark>`), worked),
      summary: `Added your answer: ${answer}.`,
      changed: true,
    };
  }
  if (!instruction) return { title, gist, markdown, summary: "I didn’t catch a change to make.", changed: false };
  const paragraphs = markdown.split(/\n{2,}/);
  if (/opening|start|beginning|direct/i.test(instruction) && paragraphs.length) {
    paragraphs[0] = "I kept one giant to-do list for three years. It never once told me what mattered today.";
    return { title, gist, markdown: paragraphs.join("\n\n"), summary: "Made the opening more direct.", changed: true };
  }
  if (/short|cut|trim/i.test(instruction) && paragraphs.length > 2) {
    paragraphs.splice(1, 1);
    return { title, gist, markdown: paragraphs.join("\n\n"), summary: "Cut the second paragraph.", changed: true };
  }
  return { title, gist, markdown, summary: "Demo mode only knows a couple of changes.", changed: false };
}

export async function mockClaude(opts: CallOptions): Promise<LlmResult> {
  await sleep(DELAY);
  switch (opts.step) {
    case "tidy":
      return { text: tidy(between(opts.user, "transcript")), sources: [] };
    case "research": {
      // Keyed the same way as the canned article below, so the two always agree.
      const canned = /to-do list/i.test(opts.user);
      return {
        text: canned
          ? [
              `DIFFERS: Eisenhower invented the matrix in 1954 | He described the idea in a 1954 speech; the matrix was devised later | ${SOURCE.url}`,
              `USEFUL: The matrix was popularised by Stephen Covey's The 7 Habits of Highly Effective People (1989) | ${SOURCE.url}`,
            ].join("\n")
          : "Nothing in the material needs checking.",
        sources: canned ? [SOURCE] : [],
      };
    }
    case "write":
      return { text: JSON.stringify(draft(between(opts.user, "material"))), sources: [] };
    case "edit":
    case "answer":
      return { text: JSON.stringify(edit(opts.user)), sources: [] };
    default:
      return { text: "", sources: [] };
  }
}
