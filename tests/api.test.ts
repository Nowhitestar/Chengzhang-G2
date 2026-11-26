import assert from "node:assert/strict";
import { test } from "node:test";
import { newClient } from "./helpers.ts";

test("a new device gets a token, and nothing works without one", async () => {
  const c = await newClient();
  assert.ok(c.token.length > 20);
  const anonymous = await c.app.request("/api/home");
  assert.equal(anonymous.status, 401);
  const home = await c.call("GET", "/api/home");
  assert.equal(home.status, 200);
  assert.deepEqual(home.data.rows, []);
  assert.equal(home.data.features.demo, true);
  assert.equal(home.data.features.simulated, "both");
});

test("talk, write it up, decide on each note, change it by voice, undo", async () => {
  const c = await newClient();
  const id = (await c.call<{ id: string }>("POST", "/api/articles")).data.id;

  // Talk: thirty seconds, then the recording is transcribed and tidied.
  await c.say(id, 30);
  let a = await c.until(id, (x) => x.recordings.length === 1 && x.recordings[0]!.status === "ready");
  assert.match(a.recordings[0]!.text, /to-do list/);
  assert.doesNotMatch(a.recordings[0]!.text, /\bum\b/i, "filler words are gone");
  assert.equal(a.status, "draft");

  // The opening page now offers to pick it up.
  let home = (await c.call("GET", "/api/home")).data;
  assert.equal(home.rows[0].kind, "draft");
  assert.equal(home.rows[0].recordings, 1);

  // Write it up.
  assert.equal((await c.call("POST", `/api/articles/${id}/compose`)).status, 200);
  a = await c.until(id, (x) => x.status === "ready");
  assert.equal(a.title, "Why I stopped keeping a to-do list");
  assert.ok(a.gist.length > 0 && a.gist.length <= 160);
  assert.deepEqual(a.annotations.map((n) => [n.id, n.kind, n.state]), [
    ["a1", "diff", "open"],
    ["a2", "added", "open"],
    ["a3", "ask", "open"],
  ]);
  assert.equal(a.seen, false);
  home = (await c.call("GET", "/api/home")).data;
  assert.equal(home.rows[0].kind, "ready");

  // Opening it clears the row.
  await c.call("POST", `/api/articles/${id}/seen`);
  home = (await c.call("GET", "/api/home")).data;
  assert.equal(home.rows.length, 0);
  assert.equal(home.finished, 1);

  // Use the correction for the claim that disagrees with the source.
  a = (await c.call("POST", `/api/articles/${id}/annotations/a1`, { action: "apply" })).data;
  assert.match(a.markdown, /named after President Eisenhower/);
  assert.doesNotMatch(a.markdown, /data-id="a1"/);

  // Remove the sentence the AI added.
  a = (await c.call("POST", `/api/articles/${id}/annotations/a2`, { action: "remove" })).data;
  assert.doesNotMatch(a.markdown, /Stephen Covey/);
  assert.equal(a.annotations.find((n) => n.id === "a2")!.state, "removed");

  // Deciding twice is refused.
  assert.equal((await c.call("POST", `/api/articles/${id}/annotations/a2`, { action: "keep" })).status, 409);

  // Answer the AI's question by voice.
  await c.say(id, 2, "answer", "a3");
  a = await c.until(id, (x) => !x.revising && x.annotations.find((n) => n.id === "a3")!.state !== "open");
  assert.equal(a.annotations.find((n) => n.id === "a3")!.state, "answered");
  assert.match(a.markdown, /for about six months/);
  assert.match(a.heard, /six months/);

  // Say a change, then take it back.
  const before = a.markdown;
  await c.say(id, 2, "instruction");
  a = await c.until(id, (x) => !x.revising && x.lastChange !== "" && x.markdown !== before);
  assert.equal(a.lastChange, "Made the opening more direct.");
  assert.match(a.markdown, /^I kept one giant to-do list for three years/);
  a = (await c.call("POST", `/api/articles/${id}/undo`)).data;
  assert.equal(a.markdown, before);

  // The export carries no markers.
  const md = (await c.call<string>("GET", `/api/articles/${id}/markdown`)).data;
  assert.match(md, /^# Why I stopped keeping a to-do list/);
  assert.doesNotMatch(md, /<mark/);
});

test("a kept addition travels with its source", async () => {
  const c = await newClient();
  const id = (await c.call<{ id: string }>("POST", "/api/articles")).data.id;
  await c.say(id, 30);
  await c.call("POST", `/api/articles/${id}/compose`);
  await c.until(id, (x) => x.status === "ready");
  await c.call("POST", `/api/articles/${id}/annotations/a2`, { action: "keep" });
  const md = (await c.call<string>("GET", `/api/articles/${id}/markdown`)).data;
  assert.match(md, /published in 1989\.\[\^1\]/);
  assert.match(md, /\[\^1\]: \[Time management.*\]\(https:\/\/en\.wikipedia\.org\/wiki\/Time_management\)/);
});

test("one device cannot read another's article", async () => {
  const a = await newClient();
  const id = (await a.call<{ id: string }>("POST", "/api/articles")).data.id;
  const other = (await a.call<{ token: string }>("POST", "/api/session", {})).data.token;
  const res = await a.app.request(`/api/articles/${id}`, { headers: { Authorization: `Bearer ${other}` } });
  assert.equal(res.status, 404);
});

test("silence is not turned into words, and an empty take is thrown away", async () => {
  const c = await newClient();
  const id = (await c.call<{ id: string }>("POST", "/api/articles")).data.id;
  const rec = (await c.call<{ id: string }>("POST", `/api/articles/${id}/recordings`, {})).data.id;
  await c.call("PUT", `/api/recordings/${rec}/chunks/0`, new Uint8Array(32000));
  await c.call("POST", `/api/recordings/${rec}/finish`, { chunks: 1, durationMs: 1000 });
  await new Promise((r) => setTimeout(r, 50));
  const a = await c.article(id);
  assert.deepEqual(a.recordings.map((r) => [r.status, r.error]), [["failed", "I didn’t hear anything."]], "the author is told, not left guessing");
  assert.equal((await c.call("POST", `/api/articles/${id}/compose`)).status, 409, "and it is not material to write from");
  assert.deepEqual((await c.call("GET", "/api/home")).data.rows, [], "nor does it put the article on the opening page");

  const rec2 = (await c.call<{ id: string }>("POST", `/api/articles/${id}/recordings`, {})).data.id;
  const done = await c.call("POST", `/api/recordings/${rec2}/finish`, { chunks: 0 });
  assert.equal(done.data.discarded, true);
});

test("with an access code set, a device must present it once", async () => {
  const { config } = await import("../server/config.ts");
  const c = await newClient();
  config.accessCodes = new Map([["open-sesame", 0]]);
  try {
    assert.equal(((await (await c.app.request("/api/health")).json()) as { accessCode: boolean }).accessCode, true);
    const post = (body: unknown) => c.app.request("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const refused = await post({ lang: "zh", code: "guess" });
    assert.equal(refused.status, 403);
    assert.deepEqual(await refused.json(), { error: "访问码不对。", code: "access_code" });
    assert.equal((await post({})).status, 403);
    const ok = await post({ code: " open-sesame " });
    assert.equal(ok.status, 200);
    assert.ok((await ok.json()).token);
    // The device that already has a token keeps working.
    assert.equal((await c.call("GET", "/api/home")).status, 200);
  } finally {
    config.accessCodes = new Map();
  }
});

test("oversized requests are refused", async () => {
  const c = await newClient();
  const id = (await c.call<{ id: string }>("POST", "/api/articles")).data.id;
  const big = await c.call("POST", `/api/articles/${id}/edit`, { instruction: "x".repeat(100_000) });
  assert.equal(big.status, 413);
  const rec = (await c.call<{ id: string }>("POST", `/api/articles/${id}/recordings`, {})).data.id;
  assert.equal((await c.call("PUT", `/api/recordings/${rec}/chunks/0`, new Uint8Array(1_600_000))).status, 413);
  assert.equal((await c.call("PUT", `/api/recordings/${rec}/chunks/0`, new Uint8Array(640_000))).status, 200);
});

test("an access code's daily allowance is shared by every device that came in with it, and no other", async () => {
  const { config } = await import("../server/config.ts");
  config.accessCodes = new Map([["judges", 1], ["friends", 0]]);
  try {
    const device = async (code: string, keepData: boolean) => {
      const c = await newClient("en", { keepData, code });
      const id = (await c.call<{ id: string }>("POST", "/api/articles")).data.id;
      await c.say(id, 4);
      await c.until(id, (x) => x.recordings[0]?.status === "ready");
      return { c, id };
    };
    const first = await device("judges", false);
    assert.equal((await first.c.call("POST", `/api/articles/${first.id}/compose`)).status, 200);

    // A second device with the same code: its own count is zero, but the code's is not.
    const second = await device("judges", true);
    const refused = await second.c.call<{ error: string; code: string }>("POST", `/api/articles/${second.id}/compose`);
    assert.equal(refused.status, 429);
    assert.equal(refused.data.code, "limit");
    assert.match(refused.data.error, /access code has written all it can/);

    // A device with another code is not affected.
    const other = await device("friends", true);
    assert.equal((await other.c.call("POST", `/api/articles/${other.id}/compose`)).status, 200);
  } finally {
    config.accessCodes = new Map();
  }
});
