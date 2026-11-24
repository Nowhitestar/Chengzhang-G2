/**
 * Speech to text. The glasses give raw microphone audio (16 kHz, 16-bit, mono
 * PCM); the app uploads it in slices and each slice is transcribed here.
 *
 * Two providers, chosen with STT_PROVIDER:
 *  - openrouter (default): OpenRouter's transcription endpoint.
 *  - dashscope: Alibaba Cloud Model Studio's Qwen ASR, OpenAI-compatible endpoint.
 */
import type { T } from "../shared/i18n.ts";
import type { RecordingPurpose } from "../shared/types.ts";
import { config } from "./config.ts";

export class SttError extends Error {}

export const SAMPLE_RATE = 16000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;

/** Wrap raw PCM in a WAV header, the one format every provider accepts. */
export function pcmToWav(pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const v = new DataView(out.buffer);
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  v.setUint32(4, 36 + pcm.length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, SAMPLE_RATE, true);
  v.setUint32(28, BYTES_PER_SECOND, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

export const pcmMs = (pcm: Uint8Array) => Math.round((pcm.length / BYTES_PER_SECOND) * 1000);

async function failure(res: Response, t: T): Promise<SttError> {
  const body = await res.text().catch(() => "");
  let message = body.slice(0, 200);
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    message = (typeof parsed.error === "string" ? parsed.error : parsed.error?.message) || parsed.message || message;
  } catch {
    // not JSON: keep the raw text
  }
  console.error(`[stt] ${res.status} ${message}`);
  if (res.status === 401) return new SttError(t("转写密钥无效。", "The transcription key is invalid."));
  if (res.status === 402 || res.status === 403)
    return new SttError(t("转写服务没有额度或权限。", "The transcription service is out of credit or access."));
  if (res.status === 429) return new SttError(t("转写请求太频繁，稍后再试。", "Too many transcription requests. Try again shortly."));
  return new SttError(t(`转写失败（${res.status}）。`, `Transcription failed (${res.status}).`));
}

async function viaOpenRouter(wav: Uint8Array, t: T): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([wav as BlobPart], { type: "audio/wav" }), "audio.wav");
  form.append("model", config.stt.model);
  if (config.stt.language) form.append("language", config.stt.language);
  const res = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.llm.openrouterKey}` },
    body: form,
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw await failure(res, t);
  return (((await res.json()) as { text?: string }).text || "").trim();
}

async function viaDashScope(wav: Uint8Array, t: T): Promise<string> {
  const res = await fetch(`${config.stt.dashscopeBase}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.stt.dashscopeKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.stt.model,
      messages: [
        {
          role: "user",
          content: [
            { type: "input_audio", input_audio: { data: `data:audio/wav;base64,${Buffer.from(wav).toString("base64")}` } },
          ],
        },
      ],
      stream: false,
      asr_options: { enable_itn: true, ...(config.stt.language ? { language: config.stt.language } : {}) },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw await failure(res, t);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return (data.choices?.[0]?.message?.content || "").trim();
}

/** Loudest sample over full scale, 0..1. Used to skip slices that are pure silence. */
export function peak(pcm: Uint8Array): number {
  const v = new DataView(pcm.buffer, pcm.byteOffset, pcm.length - (pcm.length % 2));
  let max = 0;
  for (let i = 0; i < v.byteLength; i += 2) {
    const s = Math.abs(v.getInt16(i, true));
    if (s > max) max = s;
  }
  return max / 32768;
}

export async function transcribe(pcm: Uint8Array, t: T, hint: { purpose: RecordingPurpose; idx: number }): Promise<string> {
  // Silence in, nothing out: speech models tend to invent words for an empty clip.
  if (pcm.length < BYTES_PER_SECOND * 0.25 || peak(pcm) < 0.004) return "";
  if (config.mock.stt) return (await import("./mock.ts")).mockTranscribe(pcm, hint);
  if (!config.stt.ready) {
    throw new SttError(
      config.stt.provider === "dashscope"
        ? t("还没有配置转写密钥：请设置 DASHSCOPE_API_KEY。", "No transcription key yet: set DASHSCOPE_API_KEY.")
        : t("还没有配置转写密钥：请设置 OPENROUTER_API_KEY。", "No transcription key yet: set OPENROUTER_API_KEY."),
    );
  }
  const wav = pcmToWav(pcm);
  try {
    return config.stt.provider === "dashscope" ? await viaDashScope(wav, t) : await viaOpenRouter(wav, t);
  } catch (err) {
    if (err instanceof SttError) throw err;
    if (err instanceof Error && err.name === "TimeoutError") throw new SttError(t("转写超时了。", "Transcription timed out."));
    console.error("[stt]", err);
    throw new SttError(t("连不上转写服务。", "Can’t reach the transcription service."));
  }
}
