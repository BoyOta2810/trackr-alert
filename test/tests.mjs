// Black-box tests for check.mjs: mock Telegram server + mocked Trackr pages (see preload.mjs).
// Usage: npm test   (or: node test/tests.mjs <path to another check.mjs>)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const SRC = path.resolve(process.argv[2] ?? fileURLToPath(new URL("../check.mjs", import.meta.url)));
const REPO = path.dirname(SRC);
const TOKEN = "123:TESTTOKEN";

// ---- mock Telegram -------------------------------------------------------
let tg; // per-test config + log
const server = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    const method = req.url.split("/").pop();
    const body = data ? JSON.parse(data) : {};
    tg.calls.push({ method, body });
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (method === "getUpdates") return send(200, { ok: true, result: tg.updates.filter((u) => u.update_id >= (body.offset || 0)) });
    if (method === "sendMessage") {
      const id = String(body.chat_id);
      const f = tg.fail[id];
      if (f === 429 && !tg.retried[id]) { tg.retried[id] = 1; return send(429, { ok: false, description: "Too Many Requests: retry after 1", parameters: { retry_after: 1 } }); }
      if (f && f !== 429) return send(f.code ?? f, { ok: false, description: f.desc ?? `err ${f}` });
      tg.delivered.push({ id, text: body.text });
      return send(200, { ok: true, result: { message_id: 1 } });
    }
    send(404, { ok: false, description: "no method" });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const MOCK_TG = `http://127.0.0.1:${server.address().port}`;

// ---- helpers --------------------------------------------------------------
const prog = (id, open = true, extra = {}) => ({
  id, name: "Prog " + id, season: "2027", type: "summer-internships", company: { name: "Co " + id }, url: "https://x/" + id,
  openingDate: open ? "2026-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z", closingDate: "2099-12-01T00:00:00.000Z", ...extra,
});
const trackr = (...ps) => JSON.stringify({ programmes: ps, groups: [] });
const msg = (update_id, id, text, type = "private") => ({ update_id, message: { text, chat: { id, type } } });

function newDir(state) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "trk-"));
  fs.copyFileSync(SRC, path.join(d, "check.mjs"));
  fs.copyFileSync(new URL("./preload.mjs", import.meta.url), path.join(d, "preload.mjs"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(d, "node_modules"), "junction"); // junction: no admin rights needed on Windows
  fs.mkdirSync(path.join(d, "state"));
  if (state) fs.writeFileSync(path.join(d, "state/seen.json"), JSON.stringify(state));
  return d;
}
const readState = (d) => JSON.parse(fs.readFileSync(path.join(d, "state/seen.json"), "utf8"));

function run(d, { trackrBody, env = {}, args = [], cfg = {} } = {}) {
  tg = { updates: [], fail: {}, retried: {}, calls: [], delivered: [], ...cfg };
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--import", "./preload.mjs", "check.mjs", ...args], {
      cwd: d,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, MOCK_TG, MOCK_TRACKR: trackrBody, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ADMIN_IDS: "999", ...env },
    });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (out += c));
    p.on("close", (code) => resolve({ code, out, tg }));
  });
}

// Subscriber list regardless of whether it is stored in plain text or sealed.
// Sealed lists can only be read by the code under test, so tests check delivery instead.
const plainSubs = (s) => s.telegram?.subscribers;

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(["PASS", name]); }
  catch (e) { results.push(["FAIL", name, e.message]); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const day = "2026-10-29";
// Default clock: 07:00 London, so the heartbeat stays quiet unless a test wants it.
const EARLY = { FAKE_NOW: `${day}T06:00:00Z` };
const base = (subs = ["111"], extra = {}) => ({ initialised: true, open: { a: "x" }, telegram: { offset: 0, subscribers: subs }, ...extra });

// ---- tests ----------------------------------------------------------------
await test("first run records open programmes silently", async () => {
  const d = newDir();
  const r = await run(d, { trackrBody: trackr(prog("a"), prog("b", false)), env: EARLY });
  assert(r.code === 0, "exit " + r.code + r.out);
  const s = readState(d);
  assert(s.initialised && s.open.a && !s.open.b, "state " + JSON.stringify(s.open));
  assert(!r.tg.delivered.length, "sent " + JSON.stringify(r.tg.delivered));
});

await test("/start subscribes (private only), /start in group ignored", async () => {
  const d = newDir(base([]));
  const r = await run(d, { trackrBody: trackr(prog("a")), env: EARLY, cfg: { updates: [msg(5, 111, "/start"), msg(6, -50, "/start", "group")] } });
  assert(r.code === 0, "exit " + r.code + r.out);
  assert(r.tg.delivered.some((m) => m.id === "111" && /subscribed/.test(m.text)), "no confirm");
  assert(!r.tg.delivered.some((m) => m.id === "-50"), "group got reply");
  assert(readState(d).telegram.offset === 7, "offset");
  // proves 111 is subscribed: a new programme reaches them
  const r2 = await run(d, { trackrBody: trackr(prog("a"), prog("n")), env: EARLY });
  assert(r2.tg.delivered.some((m) => m.id === "111" && /Prog n/.test(m.text)), "subscriber not alerted");
});

await test("/stop unsubscribes", async () => {
  const d = newDir(base(["111", "222"]));
  await run(d, { trackrBody: trackr(prog("a")), env: EARLY, cfg: { updates: [msg(1, 111, "/stop")] } });
  const r = await run(d, { trackrBody: trackr(prog("a"), prog("n")), env: EARLY });
  assert(!r.tg.delivered.some((m) => m.id === "111"), "111 still alerted");
  assert(r.tg.delivered.some((m) => m.id === "222"), "222 not alerted");
});

await test("200-subscriber cap", async () => {
  const subs = Array.from({ length: 200 }, (_, i) => String(1000 + i));
  const d = newDir(base(subs));
  const r = await run(d, { trackrBody: trackr(prog("a")), env: EARLY, cfg: { updates: [msg(1, 777, "/start"), msg(2, 1000, "/start")] } });
  assert(r.tg.delivered.some((m) => m.id === "777" && /full/.test(m.text)), "777 not told full");
  assert(r.tg.delivered.some((m) => m.id === "1000" && /subscribed/.test(m.text)), "existing sub not re-confirmed");
  const r2 = await run(d, { trackrBody: trackr(prog("a"), prog("n")), env: EARLY });
  assert(!r2.tg.delivered.some((m) => m.id === "777"), "777 got alert");
  assert(r2.tg.delivered.filter((m) => /Prog n/.test(m.text)).length === 200, "not all 200 alerted: " + r2.tg.delivered.length);
});

await test("new programme alerts once (duplicate suppression)", async () => {
  const d = newDir(base());
  const r1 = await run(d, { trackrBody: trackr(prog("a"), prog("n")), env: EARLY });
  const r2 = await run(d, { trackrBody: trackr(prog("a"), prog("n")), env: EARLY });
  assert(r1.tg.delivered.filter((m) => /Prog n/.test(m.text)).length === 1, "first run count");
  assert(!r2.tg.delivered.some((m) => /Prog n/.test(m.text)), "duplicate");
});

await test("blocked user (403) is removed, others still alerted, programme marked seen", async () => {
  const d = newDir(base(["111", "222"]));
  const r = await run(d, { trackrBody: trackr(prog("a"), prog("n")), env: EARLY, cfg: { fail: { 222: { code: 403, desc: "Forbidden: bot was blocked by the user" } } } });
  assert(r.tg.delivered.some((m) => m.id === "111"), "111 not alerted");
  assert(readState(d).open.n, "not marked seen");
  const r2 = await run(d, { trackrBody: trackr(prog("a"), prog("n"), prog("m")), env: EARLY });
  assert(!r2.tg.calls.some((c) => c.method === "sendMessage" && String(c.body.chat_id) === "222"), "222 still messaged");
});

await test("a 400 that is not 'chat not found' does NOT drop the subscriber", async () => {
  const d = newDir(base(["111", "222"]));
  await run(d, { trackrBody: trackr(prog("a"), prog("n")), env: EARLY, cfg: { fail: { 222: { code: 400, desc: "Bad Request: message is too long" } } } });
  const r2 = await run(d, { trackrBody: trackr(prog("a"), prog("n"), prog("m")), env: EARLY });
  assert(r2.tg.delivered.some((m) => m.id === "222"), "222 was dropped");
});

await test("429 rate limit is retried", async () => {
  const d = newDir(base(["111"]));
  const r = await run(d, { trackrBody: trackr(prog("a"), prog("n")), env: EARLY, cfg: { fail: { 111: 429 } } });
  assert(r.tg.delivered.some((m) => m.id === "111" && /Prog n/.test(m.text)), "not retried");
});

await test("nothing delivered => programme NOT marked seen", async () => {
  const d = newDir(base(["111"]));
  const r = await run(d, { trackrBody: trackr(prog("a"), prog("n")), env: EARLY, cfg: { fail: { 111: 500 } } });
  assert(!readState(d).open.n, "marked seen though nothing delivered");
  assert(r.code !== 0, "exit 0");
});

await test("no recipients => programme NOT marked seen", async () => {
  const d = newDir(base([]));
  await run(d, { trackrBody: trackr(prog("a"), prog("n")), env: EARLY });
  assert(!readState(d).open.n, "marked seen with no recipients");
});

await test("heartbeat: not before 08:00 London, once per day after", async () => {
  const d = newDir(base());
  const hb = (r) => r.tg.delivered.filter((m) => m.id === "999" && /running/.test(m.text)).length;
  const t = (iso) => run(d, { trackrBody: trackr(prog("a")), env: { FAKE_NOW: iso } });
  // BST ended 2026-10-25, so London = UTC on this date.
  assert(hb(await t(`${day}T07:59:00Z`)) === 0, "sent before 08:00");
  assert(hb(await t(`${day}T08:01:00Z`)) === 1, "not sent after 08:00");
  assert(hb(await t(`${day}T15:00:00Z`)) === 0, "sent twice same day");
  assert(hb(await t(`2026-10-30T08:10:00Z`)) === 1, "not sent next day");
  // Summer time: 07:30 UTC = 08:30 BST must send
  const d2 = newDir(base());
  const r = await run(d2, { trackrBody: trackr(prog("a")), env: { FAKE_NOW: "2026-07-01T07:30:00Z" } });
  assert(hb(r) === 1, "BST not handled");
});

await test("site returns zero programmes => one admin alert, rate-limited, state.open untouched", async () => {
  const d = newDir(base());
  const before = JSON.stringify(readState(d).open);
  const r1 = await run(d, { trackrBody: trackr(), env: EARLY });
  const r2 = await run(d, { trackrBody: trackr(), env: { FAKE_NOW: `${day}T06:05:00Z` } });
  const alerts = (r) => r.tg.delivered.filter((m) => m.id === "999").length;
  assert(r1.code !== 0, "run did not fail");
  assert(alerts(r1) === 1, "no admin alert: " + JSON.stringify(r1.tg.delivered));
  assert(alerts(r2) === 0, "alert repeated after 5 min");
  assert(JSON.stringify(readState(d).open) === before, "open changed");
  const r3 = await run(d, { trackrBody: trackr(prog("a")), env: { FAKE_NOW: `${day}T06:10:00Z` } });
  assert(r3.code === 0 && r3.tg.delivered.some((m) => m.id === "999" && /back to normal|recovered/i.test(m.text)), "no recovery msg");
});

await test("changed JSON shape => admin alert", async () => {
  const d = newDir(base());
  const r = await run(d, { trackrBody: JSON.stringify({ items: [prog("a")] }), env: EARLY });
  assert(r.code !== 0, "run did not fail");
  assert(r.tg.delivered.some((m) => m.id === "999"), "no admin alert");
});

await test("subscriber IDs are not stored in plain text", async () => {
  const d = newDir(base(["111", "222"]));
  await run(d, { trackrBody: trackr(prog("a")), env: EARLY });
  const raw = fs.readFileSync(path.join(d, "state/seen.json"), "utf8");
  assert(!/"111"|"222"/.test(raw), "plain IDs in state");
  const r = await run(d, { trackrBody: trackr(prog("a"), prog("n")), env: EARLY });
  assert(["111", "222"].every((id) => r.tg.delivered.some((m) => m.id === id)), "existing subscribers lost in migration");
});

await test("DRY_RUN does not write state or call Telegram", async () => {
  const d = newDir(base());
  const before = fs.readFileSync(path.join(d, "state/seen.json"), "utf8");
  const r = await run(d, { trackrBody: trackr(prog("a"), prog("n")), env: { ...EARLY, DRY_RUN: "1" } });
  assert(r.code === 0, "exit " + r.code + r.out);
  assert(fs.readFileSync(path.join(d, "state/seen.json"), "utf8") === before, "state written");
  assert(!r.tg.calls.length, "telegram called");
});


await test("--failed (setup step failed) alerts once, repeats after 6h", async () => {
  const d = newDir(base());
  const alerts = (r) => r.tg.delivered.filter((m) => m.id === "999" && /failed/.test(m.text)).length;
  assert(alerts(await run(d, { args: ["--failed"], env: { FAKE_NOW: `${day}T06:00:00Z` } })) === 1, "no alert");
  assert(alerts(await run(d, { args: ["--failed"], env: { FAKE_NOW: `${day}T11:00:00Z` } })) === 0, "repeated within 6h");
  assert(alerts(await run(d, { args: ["--failed"], env: { FAKE_NOW: `${day}T12:01:00Z` } })) === 1, "no 6h reminder");
});

await test("changed bot token: run fails and alerts, sealed list kept", async () => {
  const d = newDir(base(["111"]));
  await run(d, { trackrBody: trackr(prog("a")), env: EARLY });
  const sealed = readState(d).telegram.sealed;
  const r = await run(d, { trackrBody: trackr(prog("a"), prog("n")), env: { ...EARLY, TELEGRAM_BOT_TOKEN: "456:OTHER" } });
  assert(r.code !== 0 && r.tg.delivered.some((m) => m.id === "999" && /decrypt/.test(m.text)), "no alert");
  assert(readState(d).telegram.sealed === sealed && !readState(d).open.n, "state changed");
});

const readFeed = (d) => (fs.existsSync(path.join(d, "state/feed.json")) ? JSON.parse(fs.readFileSync(path.join(d, "state/feed.json"), "utf8")) : null);

await test("feed: first run adds nothing; alerted programmes are added newest first, once", async () => {
  const d = newDir();
  await run(d, { trackrBody: trackr(prog("a")), env: EARLY });
  assert(readFeed(d) === null, "first run wrote a feed");
  fs.writeFileSync(path.join(d, "state/seen.json"), JSON.stringify({ ...readState(d), telegram: { offset: 0, subscribers: ["111"] } }));
  await run(d, { trackrBody: trackr(prog("a"), prog("n")), env: EARLY });
  await run(d, { trackrBody: trackr(prog("a"), prog("n"), prog("m")), env: EARLY });
  const f = readFeed(d);
  assert(f && f.items.map((i) => i.id).join() === "m,n", "feed " + JSON.stringify(f?.items?.map((i) => i.id)));
  const n = f.items[1];
  assert(n.company === "Co n" && n.name === "Prog n" && n.url === "https://x/n" && n.type === "summer-internships" && n.opened_at, "item " + JSON.stringify(n));
  assert(!JSON.stringify(f).includes("111"), "subscriber id leaked into the feed");
});

await test("feed: nothing added when no alert was delivered", async () => {
  const d = newDir(base(["111"]));
  await run(d, { trackrBody: trackr(prog("a"), prog("n")), env: EARLY, cfg: { fail: { 111: 500 } } });
  assert(readFeed(d) === null, "feed written although nobody got the alert");
});

server.close();
for (const r of results) console.log(r.join("  "));
console.log(`${results.filter((r) => r[0] === "PASS").length}/${results.length} passed`);
process.exitCode = results.some((r) => r[0] === "FAIL") ? 1 : 0;
