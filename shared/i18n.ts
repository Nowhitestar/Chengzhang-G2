import type { Lang } from "./types.ts";

/** Every string is written in both languages side by side: t("开始讲", "Start talking"). */
export type T = (zh: string, en: string) => string;

export const makeT =
  (lang: Lang): T =>
  (zh, en) =>
    lang === "zh" ? zh : en;

export const isLang = (v: unknown): v is Lang => v === "zh" || v === "en";

/** Chinese if the first preferred language is Chinese, otherwise English. */
export function langFromTag(tag: string | null | undefined): Lang {
  const first = (tag || "").split(",")[0]?.trim().toLowerCase() || "";
  return first.startsWith("zh") ? "zh" : "en";
}
