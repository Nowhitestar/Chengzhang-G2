/**
 * "Send to Notion": the finished article becomes a new page under the page
 * named by NOTION_PARENT_PAGE_ID, using an internal integration token
 * (NOTION_TOKEN) that has been given access to that page.
 */
import { config } from "./config.ts";

const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";
/** Notion's limits: 2000 characters per text run, 100 blocks per request. */
const MAX_RUN = 2000;
const MAX_BLOCKS = 100;

interface RichText {
  type: "text";
  text: { content: string; link?: { url: string } };
  annotations?: { bold?: boolean; italic?: boolean; code?: boolean; strikethrough?: boolean };
}
export type Block = { object: "block"; type: string } & Record<string, unknown>;

const INLINE = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|~~([^~]+)~~|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\[\^([\w-]+)\])/g;

/** Inline Markdown as Notion text runs: bold, italic, strikethrough, code, links, footnote marks. */
export function richText(md: string): RichText[] {
  const runs: RichText[] = [];
  const push = (content: string, extra: Partial<RichText> & { link?: string } = {}) => {
    for (let i = 0; i < content.length; i += MAX_RUN) {
      const { link, ...rest } = extra;
      runs.push({ type: "text", text: { content: content.slice(i, i + MAX_RUN), ...(link ? { link: { url: link } } : {}) }, ...rest });
    }
  };
  let last = 0;
  for (const m of md.matchAll(INLINE)) {
    if (m.index > last) push(md.slice(last, m.index));
    if (m[2] ?? m[3]) push((m[2] ?? m[3])!, { annotations: { bold: true } });
    else if (m[4]) push(m[4], { annotations: { italic: true } });
    else if (m[5]) push(m[5], { annotations: { strikethrough: true } });
    else if (m[6]) push(m[6], { annotations: { code: true } });
    else if (m[7] && m[8]) push(m[7], { link: m[8] });
    else if (m[9]) push(`[${m[9]}]`);
    last = m.index + m[0].length;
  }
  if (last < md.length) push(md.slice(last));
  return runs;
}

const textBlock = (type: string, md: string): Block => ({ object: "block", type, [type]: { rich_text: richText(md) } });

/** The Markdown this app produces, as Notion blocks. Anything unusual falls back to a paragraph. */
export function markdownToBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push(textBlock("paragraph", paragraph.join(" ")));
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s{0,3}(```|~~~)\s*(\S*)/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!); i++) body.push(lines[i]!);
      blocks.push({
        object: "block",
        type: "code",
        code: { rich_text: [{ type: "text", text: { content: body.join("\n").slice(0, MAX_RUN) } }], language: "plain text" },
      });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ object: "block", type: "divider", divider: {} });
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push(textBlock(`heading_${Math.min(3, heading[1]!.length)}`, heading[2]!));
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      blocks.push(textBlock("bulleted_list_item", bullet[1]!));
      continue;
    }
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      flush();
      blocks.push(textBlock("numbered_list_item", numbered[1]!));
      continue;
    }
    const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      blocks.push(textBlock("quote", quote[1]!));
      continue;
    }
    const footnote = /^\[\^([\w-]+)\]:\s*(.*)$/.exec(line);
    if (footnote) {
      flush();
      blocks.push(textBlock("paragraph", `[${footnote[1]}] ${footnote[2]}`));
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

async function notion(path: string, method: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.notion.token}`, "Notion-Version": VERSION, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`Notion ${res.status}: ${String(data.message ?? "").slice(0, 200)}`);
  return data;
}

/** Notion accepts a page id with or without dashes, or pasted as the tail of a page URL. */
export function pageId(input: string): string {
  const hex = /([0-9a-f]{32})\s*$/i.exec(input.replace(/-/g, "").split("?")[0] ?? "")?.[1];
  return hex ?? input;
}

/** Create the page and return its URL. */
export async function publishToNotion(title: string, markdown: string): Promise<string> {
  const blocks = markdownToBlocks(markdown);
  const page = await notion("/pages", "POST", {
    parent: { page_id: pageId(config.notion.parentPageId) },
    properties: { title: { title: [{ type: "text", text: { content: (title || "Untitled").slice(0, MAX_RUN) } }] } },
    children: blocks.slice(0, MAX_BLOCKS),
  });
  for (let i = MAX_BLOCKS; i < blocks.length; i += MAX_BLOCKS) {
    await notion(`/blocks/${String(page.id)}/children`, "PATCH", { children: blocks.slice(i, i + MAX_BLOCKS) });
  }
  return String(page.url ?? "");
}
