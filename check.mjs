// Checks Trackr's UK Finance tracker and sends a Telegram
// message when a programme opens. Loads the page in a real headless browser and reads the
// programme list the page itself fetches.
//
// `node check.mjs --failed` only sends the (rate-limited) failure alert; the workflow runs it when
// an earlier step failed, so it must not need Playwright.
import fs from "node:fs/promises";
import crypto from "node:crypto";

const TYPES = (process.env.TRACKR_TYPES || "summer-internships").split(",").map((s) => s.trim());
const SEASON = process.env.TRACKR_SEASON || "2027";
const STATE_FILE = new URL("./state/seen.json", import.meta.url);
const FEED_FILE = new URL("./state/feed.json", import.meta.url);
const FEED_MAX = 300;
const DRY_RUN = process.env.DRY_RUN === "1";
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMINS = (process.env.TELEGRAM_ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
const ALERT_REPEAT_MS = 6 * 3600_000; // while still failing, remind the admin every 6 hours

// ---- State ---------------------------------------------------------------
// state/seen.json is public, so the subscriber list is stored encrypted ("sealed") with a key
// derived from the bot token. Old plain-text lists are read once and sealed on the next save.
// If the token is ever replaced, the old list can't be decrypted: the run fails and alerts the
// admin, and the sealed list is kept as-is (never wiped).
const key = () => crypto.createHash("sha256").update("trackr-subscribers:" + TOKEN).digest();
function seal(ids) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(ids)), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString("base64");
}
function unseal(s) {
  const b = Buffer.from(s, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString());
}

let loadedSubs; // JSON of the list as loaded, to avoid re-sealing (and committing) when unchanged
async function loadState() {
  let s;
  try {
    s = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e; // a corrupt file must not silently reset everything
    s = { initialised: false, open: {} };
  }
  s.telegram ??= { offset: 0, subscribers: [] };
  if (s.telegram.sealed && TOKEN) {
    try {
      s.telegram.subscribers = unseal(s.telegram.sealed);
      loadedSubs = JSON.stringify(s.telegram.subscribers);
    } catch {
      delete s.telegram.subscribers; // unknown: don't send, don't overwrite
    }
  }
  return s;
}

async function saveState(state) {
  if (DRY_RUN) return;
  const { subscribers, ...tgState } = state.telegram;
  if (subscribers && TOKEN) {
    if (JSON.stringify(subscribers) !== loadedSubs) tgState.sealed = seal(subscribers);
  } else if (subscribers) tgState.subscribers = subscribers;
  await fs.mkdir(new URL("./state/", import.meta.url), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify({ ...state, telegram: tgState }, null, 2) + "\n");
}

// state/feed.json: the newest opened programmes, newest first, for apps that act on them (JobPilot
// drafts applications from it). It holds only what the public alerts already say; no subscriber data.
async function appendFeed(programmes, at) {
  if (DRY_RUN || !programmes.length) return;
  let feed = { items: [] };
  try {
    feed = JSON.parse(await fs.readFile(FEED_FILE, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const known = new Set(feed.items.map((i) => i.id));
  const fresh = programmes
    .filter((p) => !known.has(p.id))
    .map((p) => ({
      id: p.id,
      company: p.company?.name ?? p.companyId ?? "",
      name: p.name,
      type: p.type,
      season: p.season ?? SEASON,
      url: p.url ?? null,
      trackr_url: `https://app.the-trackr.com/uk-finance/${p.type}`,
      opening_date: p.openingDate ?? null,
      closing_date: p.closingDate ?? null,
      opened_at: at,
    }));
  const items = [...fresh.reverse(), ...feed.items].slice(0, FEED_MAX);
  await fs.writeFile(FEED_FILE, JSON.stringify({ updated_at: at, items }, null, 2) + "\n");
}

function subscribersOrThrow(state) {
  if (!state.telegram.subscribers) {
    throw new Error("Can't decrypt the subscriber list (was TELEGRAM_BOT_TOKEN changed?). Nothing was deleted.");
  }
  return state.telegram.subscribers;
}

// ---- Trackr --------------------------------------------------------------
async function fetchProgrammes(page, type) {
  const resp = page.waitForResponse(
    (r) => r.url().includes("/programmes?") && r.url().includes(`type=${type}`),
    { timeout: 45_000 },
  );
  await page.goto(`https://app.the-trackr.com/uk-finance/${type}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  const r = await resp;
  if (r.status() !== 200) throw new Error(`Trackr /programmes returned HTTP ${r.status()} (blocked?)`);
  const body = await r.json();
  // An empty or reshaped answer almost always means the site changed or blocked us, not that
  // every programme vanished. Fail loudly instead of quietly finding nothing new.
  if (!Array.isArray(body?.programmes)) {
    throw new Error(`Trackr response has no programmes list (keys: ${Object.keys(body ?? {}).join(", ")})`);
  }
  const list = body.programmes.filter((p) => p.season === SEASON);
  if (!list.length) throw new Error(`Trackr returned 0 ${type} programmes for ${SEASON} (${body.programmes.length} in total)`);
  if (list.some((p) => !p.id || !("openingDate" in p))) throw new Error("Trackr programmes no longer have id/openingDate");
  return list;
}

function isOpen(p, now) {
  if (!p.openingDate || new Date(p.openingDate) > now) return false;
  return !p.closingDate || new Date(p.closingDate) >= now;
}

// ---- Telegram ------------------------------------------------------------
// The bot is public: anyone who opens it and presses Start is subscribed, /stop unsubscribes.
// TELEGRAM_CHAT_IDS (optional) are always-on extras, e.g. a channel or group.
const MAX_SUBSCRIBERS = Number(process.env.MAX_SUBSCRIBERS || 200);

async function tg(method, body) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok !== false) return j.result;
    // Telegram allows ~30 messages/second; on 429 wait as told and retry.
    const wait = j.parameters?.retry_after;
    if (r.status === 429 && wait && attempt < 3) {
      await new Promise((ok) => setTimeout(ok, wait * 1000));
      continue;
    }
    const err = new Error(`Telegram ${method} ${r.status}: ${j.description ?? ""}`);
    err.status = r.status;
    err.description = j.description ?? "";
    throw err;
  }
}

async function syncTelegramSubscribers(state) {
  if (!TOKEN || DRY_RUN) return;
  const subs = new Set(subscribersOrThrow(state));
  const updates = await tg("getUpdates", { offset: state.telegram.offset, timeout: 0, allowed_updates: ["message"] });
  for (const u of updates) {
    state.telegram.offset = u.update_id + 1;
    const m = u.message;
    if (!m?.text || m.chat?.type !== "private") continue;
    const cmd = m.text.trim().split(/[\s@]/)[0].toLowerCase();
    const id = String(m.chat.id);
    let reply;
    if (cmd === "/start") {
      if (!subs.has(id) && subs.size >= MAX_SUBSCRIBERS) reply = "Sorry, this bot is full right now.";
      else {
        subs.add(id);
        reply = "✅ You're subscribed. I'll message you when a new UK Finance programme opens on Trackr. Send /stop to unsubscribe.";
      }
    } else if (cmd === "/stop") {
      subs.delete(id);
      reply = "You're unsubscribed. Send /start any time to subscribe again.";
    } else continue;
    await tg("sendMessage", { chat_id: m.chat.id, text: reply }).catch(() => {});
  }
  state.telegram.subscribers = [...subs];
}

// Sends to every recipient, one at a time (Telegram rate limits bursts). One failing recipient
// doesn't stop the others. Throws if nobody got it, so the programmes stay "unseen" and are
// retried next run.
async function notify(text, state) {
  if (DRY_RUN) return console.log("[dry run] would send:\n" + text);
  if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  const fixed = (process.env.TELEGRAM_CHAT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const subs = subscribersOrThrow(state);
  const recipients = [...new Set([...fixed, ...subs])];
  if (!recipients.length) throw new Error("No recipients yet: nobody has pressed Start on the bot");
  let delivered = 0;
  for (const chatId of recipients) {
    try {
      await tg("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
      delivered++;
    } catch (e) {
      console.error(`failed -> telegram ${chatId}: ${e.message}`);
      // Someone who blocked the bot or deleted the chat is dropped. Other errors (e.g. a bad
      // message) are not their fault, so they stay subscribed.
      const gone = e.status === 403 || (e.status === 400 && /chat not found|user is deactivated/i.test(e.description));
      if (gone && !fixed.includes(chatId)) {
        state.telegram.subscribers = state.telegram.subscribers.filter((id) => id !== chatId);
      }
    }
  }
  if (!delivered) throw new Error("Every notification failed");
}

async function tellAdmins(text) {
  if (!TOKEN || DRY_RUN || !ADMINS.length) return false;
  const res = await Promise.allSettled(ADMINS.map((id) => tg("sendMessage", { chat_id: id, text })));
  return res.some((r) => r.status === "fulfilled");
}

function londonParts(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

// How many runs the 5-minute trigger (workflow_dispatch) started in the last 24h, from the GitHub
// API (only available inside Actions). Near zero means the Worker stopped and only the fallback runs.
async function runsLast24h() {
  const { GITHUB_TOKEN: t, GITHUB_REPOSITORY: repo } = process.env;
  if (!t || !repo) return null;
  const since = new Date(Date.now() - 86400_000).toISOString();
  const r = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/check.yml/runs?created=${encodeURIComponent(">" + since)}&event=workflow_dispatch&per_page=1`,
    { headers: { authorization: `Bearer ${t}`, accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(10_000) },
  ).catch(() => null);
  return r?.ok ? (await r.json()).total_count : null;
}

// Once a day (after 08:00 London time) tells the admin(s) the bot is alive. If this message ever
// stops arriving, the schedule has stopped. The run count shows whether the 5-minute trigger works.
async function heartbeat(state) {
  const { day, hour } = londonParts(new Date());
  if (hour < 8 || state.lastHeartbeat === day) return;
  const runs = await runsLast24h();
  const text =
    `✅ Trackr bot is running.\n${Object.keys(state.open).length} programmes seen open so far, ` +
    `${state.telegram.subscribers?.length ?? "?"} subscriber(s).\n` +
    (runs === null ? "" : `${runs} runs from the 5-minute trigger in the last 24h (about 288 expected).\n`) +
    `Last check: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC.`;
  if (await tellAdmins(text)) state.lastHeartbeat = day;
}

// One alert when something breaks, a reminder every 6 hours while it stays broken, and one
// message when it works again.
async function reportFailure(state, reason) {
  const now = Date.now();
  state.failure ??= { since: new Date(now).toISOString(), lastAlert: 0 };
  state.failure.reason = reason;
  if (now - state.failure.lastAlert < ALERT_REPEAT_MS) return;
  const run = process.env.GITHUB_RUN_ID
    ? `\n${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : "";
  const text = `⚠️ Trackr bot check failed (failing since ${state.failure.since.slice(0, 16).replace("T", " ")} UTC).\n${reason}${run}`;
  if (await tellAdmins(text)) state.failure.lastAlert = now;
}

async function reportRecovery(state) {
  if (!state.failure) return;
  if (state.failure.lastAlert) await tellAdmins("✅ Trackr bot is back to normal.");
  delete state.failure;
}

// ---- Main ----------------------------------------------------------------
async function check(state) {
  if (TOKEN && !DRY_RUN) subscribersOrThrow(state);
  // A Telegram hiccup here must not stop the site check.
  await syncTelegramSubscribers(state).catch((e) => console.error("subscriber sync failed:", e.message));
  await saveState(state); // keep the Telegram offset even if the site check fails below
  const now = new Date();
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const fresh = [];
  try {
    const page = await browser.newPage();
    for (const type of TYPES) {
      for (const p of await fetchProgrammes(page, type)) {
        if (isOpen(p, now) && !state.open[p.id] && !fresh.some((f) => f.id === p.id)) fresh.push({ ...p, type });
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`${fresh.length} newly open programme(s)`);

  // First run only records what's already open, so you don't get 100 messages.
  // After that a programme only counts as seen once its message reached at least one person.
  for (let i = 0; i < fresh.length; i += 5) {
    const chunk = fresh.slice(i, i + 5); // keep messages short
    if (state.initialised) {
      const lines = chunk.map(
        (p) =>
          `🟢 ${p.company?.name ?? p.companyId} — ${p.name}\n` +
          (p.closingDate ? `Closes ${p.closingDate.slice(0, 10)}\n` : "") +
          (p.url ?? `https://app.the-trackr.com/uk-finance/${p.type}`),
      );
      await notify(`New on Trackr UK Finance:\n\n${lines.join("\n\n")}`, state);
      await appendFeed(chunk, now.toISOString());
    }
    for (const p of chunk) state.open[p.id] = now.toISOString();
    await saveState(state);
  }
  state.initialised = true;
}

const state = await loadState();
try {
  if (process.argv.includes("--failed")) {
    await reportFailure(state, state.failure?.reason ?? "A workflow step failed (see the run log).");
  } else {
    await check(state);
    await reportRecovery(state);
    await heartbeat(state);
  }
} catch (e) {
  console.error(e);
  await reportFailure(state, String(e.message ?? e).slice(0, 500)).catch((e2) => console.error(e2));
  process.exitCode = 1;
}
await saveState(state);
