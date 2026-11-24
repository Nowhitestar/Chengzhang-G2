/**
 * Every call to Claude goes through here, with the official SDK.
 *
 * Two ways in, same code path:
 *  - ANTHROPIC_API_KEY set: straight to Anthropic.
 *  - otherwise OPENROUTER_API_KEY: the SDK points at OpenRouter's Anthropic-compatible
 *    endpoint, so one OpenRouter key covers both transcription and writing.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import type { T } from "../shared/i18n.ts";
import { config } from "./config.ts";

/** An error worth showing to the author, in both languages. */
export class LlmError extends Error {
  readonly en: string;
  constructor(zh: string, en?: string) {
    super(en ?? zh);
    this.en = en ?? zh;
    this.zh = zh;
  }
  readonly zh: string;
  text(t: T): string {
    return t(this.zh, this.en);
  }
}

export interface Source {
  title: string;
  url: string;
}

export interface LlmResult {
  text: string;
  /** Pages the web search actually returned during this call. */
  sources: Source[];
}

export type Effort = "low" | "medium" | "high";

export interface CallOptions {
  /** Which step this is (tidy, research, write, edit). Shows up in the log line. */
  step: string;
  system: string;
  user: string;
  effort: Effort;
  maxTokens?: number;
  /** Upper bound on web searches. Leave out for no search tool. */
  webSearch?: number;
  /** Use the fact-checking model instead of the writing model. */
  research?: boolean;
  /** Ask for JSON in this shape. Cannot be combined with webSearch. */
  format?: z.ZodType;
}

let client: Anthropic | null = null;
let fallbackUnavailable = false;

function getClient(): Anthropic {
  if (client) return client;
  if (config.llm.anthropicKey) {
    client = new Anthropic({ apiKey: config.llm.anthropicKey });
  } else if (config.llm.openrouterKey) {
    client = new Anthropic({ baseURL: "https://openrouter.ai/api", authToken: config.llm.openrouterKey, apiKey: null });
  } else {
    throw new LlmError(
      "还没有配置模型密钥：请设置 ANTHROPIC_API_KEY 或 OPENROUTER_API_KEY。",
      "No model key yet: set ANTHROPIC_API_KEY or OPENROUTER_API_KEY.",
    );
  }
  return client;
}

/** The fields of a reply this app reads. The beta and plain endpoints agree on them. */
interface Block {
  type: string;
  text?: string;
  content?: unknown;
  citations?: Array<{ url?: string; title?: string | null }> | null;
}
interface Reply {
  content: Block[];
  stop_reason: string | null;
  model?: string;
  usage?: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    server_tool_use?: { web_search_requests?: number | null } | null;
  } | null;
}

function collect(reply: Reply, text: string[], sources: Map<string, Source>): void {
  for (const block of reply.content) {
    if (block.type === "text" && block.text) {
      text.push(block.text);
      for (const c of block.citations ?? []) {
        if (c.url && !sources.has(c.url)) sources.set(c.url, { url: c.url, title: c.title || c.url });
      }
    } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      // A successful search carries a list of results; a failed one carries a single error object.
      for (const r of block.content as Array<{ type?: string; url?: string; title?: string }>) {
        if (r.type === "web_search_result" && r.url && !sources.has(r.url)) {
          sources.set(r.url, { url: r.url, title: r.title || r.url });
        }
      }
    }
  }
}

function friendly(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  if (err instanceof Anthropic.AuthenticationError) return new LlmError("模型密钥无效，请检查配置。", "The model key is invalid.");
  if (err instanceof Anthropic.PermissionDeniedError)
    return new LlmError("这个密钥没有额度或没有调用该模型的权限。", "This key is out of credit or has no access to the model.");
  if (err instanceof Anthropic.RateLimitError)
    return new LlmError("请求太频繁了，稍等一会儿再试。", "Too many requests. Wait a moment and try again.");
  if (err instanceof Anthropic.APIConnectionError) return new LlmError("连不上模型服务。", "Can’t reach the model service.");
  if (err instanceof Anthropic.APIError)
    return new LlmError(`模型服务出错（${err.status ?? "未知"}）。`, `The model service returned an error (${err.status ?? "unknown"}).`);
  return new LlmError("出错了，请再试一次。", "Something went wrong. Please try again.");
}

async function request(opts: CallOptions): Promise<LlmResult> {
  const c = getClient();
  const direct = config.llm.direct;
  const model = opts.research ? config.llm.researchModel : config.llm.model;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: opts.user }];
  const params = {
    model,
    max_tokens: opts.maxTokens ?? 32000,
    system: opts.system,
    thinking: { type: "adaptive" as const },
    output_config: {
      effort: opts.effort,
      ...(opts.format ? { format: zodOutputFormat(opts.format) } : {}),
    },
    ...(opts.webSearch
      ? { tools: [{ type: "web_search_20260209" as const, name: "web_search" as const, max_uses: opts.webSearch }] }
      : {}),
    // Each search re-reads the material before it; caching makes those re-reads cheap.
    ...(opts.webSearch && direct ? { cache_control: { type: "ephemeral" as const } } : {}),
  };

  const text: string[] = [];
  const sources = new Map<string, Source>();
  const started = Date.now();
  let tokensIn = 0;
  let tokensOut = 0;
  let searches = 0;
  let served = model;

  // A long turn with searches can be paused by the server; sending it back continues it.
  for (let round = 0; round < 5; round++) {
    const plain = async () => (await c.messages.stream({ ...params, messages }).finalMessage()) as unknown as Reply;
    let reply: Reply;
    if (direct && !fallbackUnavailable) {
      // Straight to Anthropic: let the server hand a declined request to its fallback model in the same call.
      try {
        reply = (await c.beta.messages
          .stream({
            ...params,
            messages: messages as Anthropic.Beta.BetaMessageParam[],
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
          })
          .finalMessage()) as unknown as Reply;
      } catch (err) {
        if (!(err instanceof Anthropic.BadRequestError)) throw err;
        // The account or model does not take the fallback parameter. If the request is bad for
        // another reason, the plain call below fails the same way and reports it.
        console.warn("[llm] server-side fallback unavailable, using plain calls:", err.message);
        fallbackUnavailable = true;
        reply = await plain();
      }
    } else {
      reply = await plain();
    }
    collect(reply, text, sources);
    served = reply.model || served;
    const u = reply.usage;
    tokensIn += (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);
    tokensOut += u?.output_tokens ?? 0;
    searches += u?.server_tool_use?.web_search_requests ?? 0;
    if (reply.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: reply.content as unknown as Anthropic.ContentBlockParam[] });
      continue;
    }
    if (reply.stop_reason === "refusal") throw new LlmError("模型拒绝处理这段内容。", "The model declined to handle this content.");
    if (reply.stop_reason === "max_tokens") throw new LlmError("内容太长，没能一次写完。", "Too long to finish in one go.");
    break;
  }
  console.log(
    `[llm] ${opts.step} ${served} in=${tokensIn} out=${tokensOut}${searches ? ` searches=${searches}` : ""} ${Date.now() - started}ms`,
  );
  return { text: text.join("").trim(), sources: Array.from(sources.values()) };
}

export async function callClaude(opts: CallOptions): Promise<LlmResult> {
  if (config.mock.llm) return (await import("./mock.ts")).mockClaude(opts);
  try {
    return await request(opts);
  } catch (err) {
    if (!(err instanceof LlmError)) console.error(`[llm] ${opts.step} failed:`, err instanceof Error ? err.message : err);
    throw friendly(err);
  }
}

/** A call that must answer in a given JSON shape. */
export async function callClaudeJson<S extends z.ZodType>(opts: Omit<CallOptions, "format" | "webSearch"> & { format: S }): Promise<z.infer<S>> {
  const { text } = await callClaude(opts);
  try {
    return opts.format.parse(JSON.parse(text));
  } catch {
    console.error(`[llm] ${opts.step}: reply did not match the expected shape`);
    throw new LlmError("模型返回的内容格式不对，请再试一次。", "The model’s reply was in the wrong format. Please try again.");
  }
}
