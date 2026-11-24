/**
 * The page on the phone. The glasses are where things happen; this page is the
 * paper next to them: it shows what the glasses are doing in words, shows the
 * article properly typeset, and holds the few things that need a real screen
 * (copying the article out, entering an access code, choosing the language).
 */
import { makeT } from "../../shared/i18n.ts";
import { hostOf, markIds, markInner } from "../../shared/text.ts";
import type { Annotation, ArticleView, Lang, LibraryRow } from "../../shared/types.ts";
import { ApiError, type Storage } from "../api.ts";
import type { App } from "../app.ts";
import { escapeHtml as e, mdToHtml } from "./markdown.ts";
import "./style.css";

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" role="img" aria-label="成章"><rect width="240" height="240" fill="#f7f4ed"/><g transform="translate(120 120) scale(1.12) translate(-120 -120)"><g stroke="#1b1a18" stroke-width="18" stroke-linecap="round" fill="none"><path d="M108 41H132"/><path d="M54 75H186"/><path d="M78 109H162"/><path d="M78 143H162"/></g><rect x="76" y="168" width="88" height="42" rx="12" fill="#c8371f"/></g></svg>`;

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export function showOutsideEven(): void {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root || root.childElementCount) return;
  root.innerHTML = `<p class="outside">Chengzhang runs inside the Even Realities app, on G2 glasses.<br>Open this address there, or in the Even Hub simulator.</p>`;
}

export function mountPhone(app: App, storage: Storage): void {
  const root = document.querySelector<HTMLDivElement>("#app")!;
  root.innerHTML = `<main class="page">
    <header class="top" data-part="top"></header>
    <div data-part="banner"></div>
    <section class="now" data-part="now"></section>
    <div data-part="article"></div>
    <div data-part="library"></div>
    <footer class="hint" data-part="hint"></footer>
  </main>`;
  const parts = new Map<string, HTMLElement>();
  root.querySelectorAll<HTMLElement>("[data-part]").forEach((el) => parts.set(el.dataset.part!, el));
  const shown = new Map<string, string>();
  /** Replace a part only when it actually changed, so typing and scrolling are not disturbed. */
  const put = (name: string, html: string) => {
    if (shown.get(name) === html) return;
    shown.set(name, html);
    parts.get(name)!.innerHTML = html;
  };

  let library: LibraryRow[] = [];
  let libraryFor = "";
  let codeError = "";
  let notionBusy = false;
  /** Deleting takes two taps: the first arms the button for a few seconds. */
  let deleteArmed = "";

  const toast = (message: string) => {
    document.querySelector(".toast")?.remove();
    const el = document.createElement("div");
    el.className = "toast";
    el.setAttribute("role", "status");
    el.textContent = message;
    document.body.append(el);
    window.setTimeout(() => el.remove(), 2200);
  };

  async function copy(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Older WebViews have no clipboard API: fall back to a hidden text box.
      const box = document.createElement("textarea");
      box.value = text;
      box.style.position = "fixed";
      box.style.opacity = "0";
      document.body.append(box);
      box.select();
      const ok = document.execCommand("copy");
      box.remove();
      return ok;
    }
  }

  function noteRow(a: ArticleView, n: Annotation, t: ReturnType<typeof makeT>): string {
    const kind = n.kind === "added" ? t("AI 补充", "AI added") : n.kind === "diff" ? t("有出入", "Check") : t("提问", "Question");
    const said = markInner(a.markdown, n.id);
    const main = n.kind === "added" ? said || n.note : n.kind === "diff" ? `${said ? `“${said}” → ` : ""}${n.note}` : n.note;
    const state =
      n.state === "open"
        ? ""
        : {
            kept: t("留着了", "Kept"),
            removed: t("删掉了", "Removed"),
            applied: t("按资料改了", "Corrected"),
            dismissed: n.kind === "diff" ? t("照你说的", "Left as you said") : t("跳过了", "Skipped"),
            answered: t("回答了", "Answered"),
          }[n.state];
    const src = n.sourceUrl ? `<a href="${e(n.sourceUrl)}" target="_blank" rel="noopener noreferrer">${e(n.sourceTitle || hostOf(n.sourceUrl))}</a>` : "";
    return `<li><span class="kind ${n.kind}">${e(kind)}</span><span class="${state ? "done" : ""}">${e(main)}${state ? ` · ${e(state)}` : ""}</span>${src ? `<span class="src">${src}</span>` : ""}</li>`;
  }

  function draw(): void {
    const s = app.screen;
    const lang = app.lang;
    const t = makeT(lang);
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";

    put(
      "top",
      `<div class="brand">${LOGO}<span>${t("成章", "Chengzhang")}</span></div>
       <div class="lang" role="group" aria-label="Language">
         <button data-act="lang" data-lang="en" aria-pressed="${lang === "en"}">EN</button>
         <button data-act="lang" data-lang="zh" aria-pressed="${lang === "zh"}">中文</button>
       </div>`,
    );

    put(
      "banner",
      app.api.features.demo
        ? `<div class="banner">${t(
            "演示模式：后端没有配置模型密钥，转写和写作都是模拟的。",
            "Demo mode: the backend has no model key, so transcription and writing are simulated.",
          )}</div>`
        : "",
    );

    const article = "article" in s ? s.article : null;
    const order = article ? markIds(article.markdown) : [];
    const open = article ? article.annotations.filter((n) => n.state === "open").length : 0;

    // What the glasses are doing, in words.
    let now = "";
    switch (s.name) {
      case "boot":
        now = `<h1 class="display">…</h1>`;
        break;
      case "home":
        now = `<h1 class="display">${t("想到哪，\n讲到哪。", "Think it,\nsay it.")}</h1>
          <p>${t("在眼镜上轻点镜腿，开始讲。", "Tap the temple of your glasses to start talking.")}</p>`;
        break;
      case "library":
        now = `<div class="label">${t("眼镜上", "On the glasses")}</div><h1 class="display">${t("全部文章", "All articles")}</h1>`;
        break;
      case "listening": {
        const bars = app.strokes.map((n) => (n ? `<span class="bar" style="width:${n * 14}px"></span>` : `<span class="bar break"></span>`)).join("");
        const line = s.confirm
          ? t("不要这段录音了？在眼镜上选。还在录。", "Throw this recording away? Choose on the glasses. Still recording.")
          : s.purpose === "material"
            ? t("停顿、重复都没关系。讲完在镜腿上点一下。", "Pauses are fine. Tap the temple when done.")
            : s.purpose === "instruction"
              ? t("说一句要怎么改。说完点一下。", "Say what to change. Tap when done.")
              : e(s.question);
        now = `<div class="clock" role="timer"><span class="dot" aria-hidden="true"></span>${clock(app.talkingMs)}</div>
          <div class="bars" aria-hidden="true">${bars}</div><p>${line}</p>`;
        break;
      }
      case "saving":
        now = `<h1 class="display">${t("在保存…", "Saving…")}</h1>`;
        break;
      case "notes": {
        const n = s.article.recordings.length;
        now = `<div class="label">${t("素材", "What you said")}</div>
          <h1 class="display">${t(`讲了 ${n} 段`, `${n} ${n === 1 ? "recording" : "recordings"}`)}</h1>
          <p>${t("在眼镜上选「写成文章」，或者接着讲。", "On the glasses, choose “Write it up”, or keep talking.")}</p>`;
        break;
      }
      case "composing":
        now = `<div class="label">${s.article.phase === "write" ? t("在成文", "Writing it up") : t("在查证", "Checking the facts")}</div>
          <h1 class="display">${t("正在写…", "Writing…")}</h1>
          <p>${t("要一两分钟。可以先离开，写好了会出现在打开页。", "Takes a minute or two. You can leave: it will be waiting on the opening page.")}</p>`;
        break;
      case "failed":
        now = `<h1 class="display">${t("没写成", "Couldn’t write it")}</h1><p>${e(s.article.error)}</p>`;
        break;
      case "brief":
        now = `<div class="label">${e(s.note || t("写好了", "Ready"))}</div>${
          open ? `<p>${t(`有 ${open} 处等你定：在眼镜上逐条看。`, `${open} ${open === 1 ? "note is" : "notes are"} waiting for you: go through them on the glasses.`)}</p>` : ""
        }`;
        break;
      case "review": {
        const n = s.article.annotations.find((x) => x.id === s.id);
        now = `<div class="label">${t("逐条定夺", "Going through the notes")} · ${order.indexOf(s.id) + 1}/${s.article.annotations.length}</div><p>${e(n?.note ?? "")}</p>`;
        break;
      }
      case "reader":
        now = `<div class="label">${t("在眼镜上读", "Reading on the glasses")} · ${s.page + 1}/${s.pages.length}</div>`;
        break;
      case "revising":
        now = `<h1 class="display">${t("在改…", "Changing it…")}</h1>${s.article.heard ? `<p>${t("听到的是：", "Heard: ")}“${e(s.article.heard)}”</p>` : ""}`;
        break;
      case "changed":
        now = `<div class="label">${s.article.revisionError ? t("没改成", "Not changed") : t("改好了", "Changed")}</div>
          <p>${e(s.article.revisionError || s.article.lastChange)}</p>${s.article.heard ? `<p>${t("听到的是：", "Heard: ")}“${e(s.article.heard)}”</p>` : ""}`;
        break;
      case "problem":
        now = `<h1 class="display" style="font-size:24px">${e(s.message)}</h1>${
          s.kind === "code"
            ? `<form class="form" data-form="code"><input name="code" autocomplete="off" autocapitalize="off" placeholder="${t("访问码", "Access code")}" aria-label="${t("访问码", "Access code")}"><button class="btn solid">${t("继续", "Continue")}</button></form>${codeError ? `<p role="alert">${e(codeError)}</p>` : ""}`
            : `<div class="actions"><button class="btn" data-act="retry">${t("重试", "Try again")}</button></div>`
        }`;
        break;
      case "notice":
        now = `<h1 class="display" style="font-size:24px">${e(s.message)}</h1>`;
        break;
    }
    put("now", now);

    const removeButton = (id: string) =>
      `<button class="btn quiet" data-act="delete" data-id="${e(id)}">${deleteArmed === id ? t("再点一次，彻底删除", "Tap again to delete for good") : t("删除", "Delete")}</button>`;

    // The article, typeset.
    let card = "";
    if (article && article.status === "ready" && article.markdown) {
      const notes = [...article.annotations].sort((x, y) => order.indexOf(x.id) - order.indexOf(y.id));
      card = `<article class="card">
        <h1>${e(article.title)}</h1>
        <p class="gist">${e(article.gist)}</p>
        <div class="prose">${mdToHtml(article.markdown, article.annotations)}</div>
        ${notes.length ? `<ul class="notes">${notes.map((n) => noteRow(article, n, t)).join("")}</ul>` : ""}
        <div class="actions">
          <button class="btn solid" data-act="copy" data-id="${e(article.id)}">${t("复制 Markdown", "Copy Markdown")}</button>
          ${
            app.api.features.notion
              ? article.publishedUrl
                ? `<a class="btn" href="${e(article.publishedUrl)}" target="_blank" rel="noopener noreferrer">${t("在 Notion 里打开", "Open in Notion")}</a>`
                : `<button class="btn" data-act="notion" data-id="${e(article.id)}" ${notionBusy ? "disabled" : ""}>${t("发到 Notion", "Send to Notion")}</button>`
              : ""
          }
          ${removeButton(article.id)}
        </div>
      </article>`;
    } else if (article && article.recordings.some((r) => r.text)) {
      card = `<article class="card"><div class="prose material">${article.recordings
        .filter((r) => r.text)
        .map((r) =>
          r.text
            .split(/\n{2,}/)
            .map((p) => `<p>${e(p)}</p>`)
            .join(""),
        )
        .join("<hr>")}</div><div class="actions">${removeButton(article.id)}</div></article>`;
    }
    put("article", card);

    // Everything written so far, on the opening page.
    const wantsLibrary = s.name === "home" || s.name === "library";
    if (wantsLibrary) {
      const key = s.name === "home" ? JSON.stringify(s.view?.rows ?? null) + (s.view?.finished ?? "") : "library";
      if (key !== libraryFor) {
        libraryFor = key;
        app.api
          .library()
          .then((rows) => {
            library = rows;
            draw();
          })
          .catch(() => {});
      }
    }
    const status = (r: LibraryRow) =>
      ({ draft: t("还在攒", "Collecting"), composing: t("正在写", "Writing"), failed: t("没写成", "Couldn’t write"), ready: "" })[r.status];
    put(
      "library",
      wantsLibrary && library.length
        ? `<p class="section-label">${t("写过的", "Your articles")}</p><div class="rows">${library
            .map(
              (r) =>
                `<button class="row" data-act="open" data-id="${e(r.id)}"><span class="title">${e(r.title || r.preview || t("新的一篇", "New article"))}</span><span class="sub">${e(status(r) ?? "")}</span></button>`,
            )
            .join("")}</div>`
        : "",
    );

    put(
      "hint",
      t(
        "在眼镜上：<b>点一下</b>选中或继续，<b>上下滑</b>移动，<b>双击</b>返回。讲的时候屏幕上不出字。",
        "On the glasses: <b>tap</b> to choose or continue, <b>swipe</b> to move, <b>double-tap</b> to go back. No words appear while you talk.",
      ),
    );
  }

  root.addEventListener("click", (event) => {
    const el = (event.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!el) return;
    const t = makeT(app.lang);
    const id = el.dataset.id ?? "";
    switch (el.dataset.act) {
      case "lang": {
        const lang = el.dataset.lang as Lang;
        void storage.set("chengzhang.lang", lang);
        app.setLang(lang);
        break;
      }
      case "retry":
        app.retry();
        break;
      case "open":
        app.openFromPhone(id);
        break;
      case "copy":
        void app.api
          .markdown(id)
          .then(copy)
          .then((ok) => toast(ok ? t("复制了", "Copied") : t("没能复制", "Couldn’t copy")))
          .catch(() => toast(t("没能复制", "Couldn’t copy")));
        break;
      case "delete":
        if (deleteArmed !== id) {
          deleteArmed = id;
          draw();
          window.setTimeout(() => {
            if (deleteArmed === id) {
              deleteArmed = "";
              draw();
            }
          }, 4000);
        } else {
          deleteArmed = "";
          void app
            .deleteFromPhone(id)
            .then(() => toast(t("删掉了", "Deleted")))
            .catch(() => toast(t("没能删除", "Couldn’t delete it")));
        }
        break;
      case "notion":
        notionBusy = true;
        draw();
        void app.api
          .publish(id)
          .then(({ url }) => {
            app.published(id, url);
            toast(t("发到 Notion 了", "Sent to Notion"));
          })
          .catch((err) => toast(err instanceof ApiError ? err.message : t("没能发到 Notion", "Couldn’t send it to Notion")))
          .finally(() => {
            notionBusy = false;
            draw();
          });
        break;
    }
  });

  root.addEventListener("submit", (event) => {
    const form = event.target as HTMLFormElement;
    if (form.dataset.form !== "code") return;
    event.preventDefault();
    const code = String(new FormData(form).get("code") ?? "").trim();
    if (!code) return;
    codeError = "";
    void app.enterCode(code).catch((err) => {
      codeError = err instanceof ApiError ? err.message : makeT(app.lang)("没连上，再试一次。", "Couldn’t connect. Try again.");
      shown.delete("now");
      draw();
    });
  });

  app.subscribe(draw);
  draw();
}
