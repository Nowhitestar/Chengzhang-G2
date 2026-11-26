/**
 * Everything the backend reads from the environment, in one place.
 * See .env.example for what each variable means.
 */
const env = process.env;
const num = (v: string | undefined, fallback: number) => (v && Number.isFinite(Number(v)) ? Number(v) : fallback);
const origin = (v: string) => v.trim().replace(/\/+$/, "");

const anthropicKey = env.ANTHROPIC_API_KEY || "";
const openrouterKey = env.OPENROUTER_API_KEY || "";
const dashscopeKey = env.DASHSCOPE_API_KEY || "";
const sttProvider: "openrouter" | "dashscope" = env.STT_PROVIDER === "dashscope" ? "dashscope" : "openrouter";
const sttReady = sttProvider === "dashscope" ? Boolean(dashscopeKey) : Boolean(openrouterKey);
const llmReady = Boolean(anthropicKey || openrouterKey);
// With no key at all there is nothing real to call, so the AI is simulated instead of failing.
const mockAll = env.MOCK_AI === "1" || (!llmReady && !sttReady);
const mock = { llm: mockAll || env.MOCK_LLM === "1", stt: mockAll || env.MOCK_STT === "1" };

export const config = {
  port: num(env.PORT, 8787),
  dataDir: env.DATA_DIR || "data",
  /** When set, a new device must present this code once before it gets a token. */
  accessCode: (env.ACCESS_CODE || "").trim(),
  /** Origins allowed to call the API. "*" is fine: every call needs a bearer token, never a cookie. */
  corsOrigins: (env.CORS_ORIGINS || "*").split(",").map(origin).filter(Boolean),
  /**
   * Demo mode: the AI is simulated so the whole flow can be tried without any key.
   * On when MOCK_AI=1, or when neither a writing key nor a transcription key is set.
   * MOCK_LLM=1 / MOCK_STT=1 simulate just one of the two.
   */
  mock,
  demo: mock.llm || mock.stt,
  llm: {
    anthropicKey,
    openrouterKey,
    ready: llmReady,
    /** Direct to Anthropic when ANTHROPIC_API_KEY is set, otherwise through OpenRouter. */
    direct: Boolean(anthropicKey),
    model: env.LLM_MODEL || (anthropicKey ? "claude-opus-5-5" : "anthropic/claude-opus-5.5"),
    researchModel: env.RESEARCH_MODEL || (anthropicKey ? "claude-sonnet-5-5" : "anthropic/claude-sonnet-5.5"),
    /** How many web searches fact-checking may run for one article. 0 turns fact-checking off. */
    searches: num(env.RESEARCH_SEARCHES, 4),
  },
  stt: {
    provider: sttProvider,
    ready: sttReady,
    dashscopeKey,
    dashscopeBase: origin(env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1"),
    model: env.STT_MODEL || (sttProvider === "dashscope" ? "qwen3-asr-flash" : "qwen/qwen3-asr-1.7b"),
    /** A language hint such as "en" or "zh". Empty lets the model decide. */
    language: env.STT_LANGUAGE && env.STT_LANGUAGE !== "auto" ? env.STT_LANGUAGE : "",
  },
  /** Per-device daily ceilings, so a shared deployment cannot run up an unbounded bill. */
  limits: {
    audioMinutesPerDay: num(env.MAX_AUDIO_MINUTES_PER_DAY, 60),
    composesPerDay: num(env.MAX_COMPOSES_PER_DAY, 20),
    editsPerDay: num(env.MAX_EDITS_PER_DAY, 60),
    /**
     * Ceilings for the whole server, all devices together, so a public demo cannot run up a bill
     * however many devices it is opened from. 0 means no ceiling.
     */
    server: {
      audioMinutesPerDay: num(env.MAX_SERVER_AUDIO_MINUTES_PER_DAY, 0),
      composesPerDay: num(env.MAX_SERVER_COMPOSES_PER_DAY, 0),
      editsPerDay: num(env.MAX_SERVER_EDITS_PER_DAY, 0),
    },
  },
  notion: {
    token: env.NOTION_TOKEN || "",
    /** The page new articles are created under. */
    parentPageId: (env.NOTION_PARENT_PAGE_ID || "").trim(),
  },
};

export const notionReady = () => Boolean(config.notion.token && config.notion.parentPageId);
