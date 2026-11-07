// Checks every Trackr tracker (UK Finance, UK Tech, UK Law, US Finance, ...) and sends a Telegram
// message when a programme opens, to the subscribers who follow that tracker. Loads each tab in a
// real headless browser and reads the programme list the page itself fetches. Every newly opened
// programme also goes into state/feed.json for JobPilot.
//
// `node check.mjs --failed` only sends the (rate-limited) failure alert; the workflow runs it when
// an earlier step failed, so it must not need Playwright.
import fs from "node:fs/promises";
import crypto from "node:crypto";

// Every tracker and its tabs (categories), as the page paths Trackr itself uses, in
// docs/trackers.json; the Mini App reads the same file. Events tabs are left out: they are not
// applications. A tab added there later is recorded silently on its first check.
const TRACKERS = JSON.parse(await fs.readFile(new URL("./docs/trackers.json", import.meta.url), "utf8"));
const TRACKER_OF = Object.fromEntries(Object.entries(TRACKERS).flatMap(([t, { pages }]) => pages.map((p) => [p, t])));
// "us-finance-2028/insight-programs" -> "2028 insight programs"
const tabName = (page) => page.replace(/^[a-z-]*?(\d{4})?\//, (_, y) => (y ? y + " " : "")).replace(/-/g, " ");
const WATCH = (process.env.TRACKR_TRACKERS || Object.keys(TRACKERS).join(","))
  .split(",").map((s) => s.trim()).filter((s) => TRACKERS[s]);
const DEFAULT_FOLLOW = ["uk-finance"]; // what /start gives: the bot began as UK Finance only
const SEASON = process.env.TRACKR_SEASON || "2027"; // only when a page's request names no season
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

// Subscribers are { chatId: [trackers and categories they follow] }. Lists from before trackers existed are plain
// arrays of chat ids; those people followed UK Finance.
const followers = (subs) => (Array.isArray(subs) ? Object.fromEntries(subs.map((id) => [id, [...DEFAULT_FOLLOW]])) : subs);

let loadedSubs; // JSON of the list as loaded, to avoid re-sealing (and committing) when unchanged
async function loadState() {
  let s;
  try {
    s = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e; // a corrupt file must not silently reset everything
    s = { initialised: false, open: {} };
  }
  s.telegram ??= { offset: 0, subscribers: {} };
  if (s.telegram.sealed && TOKEN) {
    try {
      const raw = unseal(s.telegram.sealed);
      loadedSubs = JSON.stringify(raw);
      s.telegram.subscribers = followers(raw);
    } catch {
      delete s.telegram.subscribers; // unknown: don't send, don't overwrite
    }
  } else if (s.telegram.subscribers) s.telegram.subscribers = followers(s.telegram.subscribers);
  // Before trackers, only UK Finance summer internships (or TRACKR_TYPES) were checked; those
  // tabs are already initialised, every other tab starts with a silent first check.
  if (s.initialised && !s.pages) {
    const old = (process.env.TRACKR_TYPES || "summer-internships").split(",").map((t) => "uk-finance/" + t.trim());
    s.pages = Object.fromEntries(old.map((p) => [p, true]));
  }
  s.pages ??= {};
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
      tracker: p.tracker,
      type: p.type,
      season: p.season ?? SEASON,
      url: p.url ?? null,
      trackr_url: `https://app.the-trackr.com/${p.page}`,
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
async function fetchProgrammes(page, path) {
  const type = path.split("/").pop();
  const resp = page.waitForResponse(
    (r) => r.url().includes("/programmes?") && r.url().includes(`type=${type}`),
    { timeout: 45_000 },
  );
  await page.goto(`https://app.the-trackr.com/${path}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  const r = await resp;
  if (r.status() !== 200) throw new Error(`Trackr /programmes for ${path} returned HTTP ${r.status()} (blocked?)`);
  const body = await r.json();
  if (!Array.isArray(body?.programmes)) {
    throw new Error(`Trackr response for ${path} has no programmes list (got: ${JSON.stringify(body).slice(0, 80)})`);
  }
  const season = new URL(r.url()).searchParams.get("season") || SEASON;
  const list = body.programmes.filter((p) => !p.season || p.season === season);
  if (list.some((p) => !p.id || !("openingDate" in p))) throw new Error("Trackr programmes no longer have id/openingDate");
  return list;
}

// Loads every tab of the watched trackers one after another in one page, which keeps Trackr's
// session check passed once (pages in parallel get empty answers). About 30 tabs take ~30 s.
// A tab that fails is reported; the others still count.
async function fetchAll(browser) {
  const page = await browser.newPage();
  const results = [];
  const errors = [];
  for (const tracker of WATCH) {
    for (const path of TRACKERS[tracker].pages) {
      try {
        results.push({ tracker, path, list: await fetchProgrammes(page, path) });
      } catch (e) {
        errors.push(e);
      }
    }
  }
  return { results, errors };
}

function isOpen(p, now) {
  if (!p.openingDate || new Date(p.openingDate) > now) return false;
  return !p.closingDate || new Date(p.closingDate) >= now;
}

// ---- Telegram ------------------------------------------------------------
// The bot is public: anyone who opens it and presses Start follows UK Finance; the Mini App and
// commands switch trackers and categories on and off. TELEGRAM_CHAT_IDS (optional) are always-on
// extras, e.g. a channel, which get TELEGRAM_CHAT_TRACKERS (default UK Finance; categories work too).
const MAX_SUBSCRIBERS = Number(process.env.MAX_SUBSCRIBERS || 10000);
const SENDS_PER_SECOND = 25; // Telegram allows about 30 messages a second per bot
const command = (tracker) => "/" + tracker.replace(/-/g, "_");
const TRACKER_COMMANDS = Object.fromEntries(Object.keys(TRACKERS).map((t) => [command(t), t]));

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
    // On 429 wait as told and retry.
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

// Runs fn over items in batches that stay under Telegram's rate limit. performance.now, not
// Date, so a faked clock in tests doesn't break the pacing.
async function paced(items, fn) {
  for (let i = 0; i < items.length; i += SENDS_PER_SECOND) {
    const started = performance.now();
    await Promise.all(items.slice(i, i + SENDS_PER_SECOND).map(fn));
    const wait = 1000 - (performance.now() - started);
    if (wait > 0 && i + SENDS_PER_SECOND < items.length) await new Promise((ok) => setTimeout(ok, wait));
  }
}

// A subscriber follows a list of whole trackers ("uk-finance") and single categories
// ("uk-tech/spring-weeks"). normalize keeps known entries, in catalogue order, and folds a
// tracker whose every category is chosen back into the tracker.
const wants = (list, p) => list.includes(p.tracker) || list.includes(p.page);
function normalize(list) {
  const set = new Set(list);
  return Object.entries(TRACKERS).flatMap(([t, { pages }]) => {
    const mine = pages.filter((p) => set.has(p));
    return set.has(t) || mine.length === pages.length ? [t] : mine;
  });
}

function trackerMenu(list) {
  const lines = Object.entries(TRACKERS).map(([t, { name }]) => {
    if (list.includes(t)) return `✅ ${name}`;
    const mine = list.filter((p) => TRACKER_OF[p] === t);
    return mine.length ? `☑️ ${name}: ${mine.map(tabName).join(", ")}` : `▫️ ${name}`;
  });
  return `Your alerts:\n${lines.join("\n")}\n\nTap ⚙️ Choose alerts below to pick trackers and categories ` +
    "(spring weeks, summer internships, ...). Changes show up on the bot's next check, within about 5 minutes.";
}

// The Mini App (docs/index.html on GitHub Pages) is opened from a keyboard button, the only kind
// whose app can send its result back as a message, which fits a bot that polls. The current
// choice rides in the URL so the app opens with it ticked.
const MINI_APP_URL = process.env.MINI_APP_URL || "https://boyota2810.github.io/trackr-alert/";
const appKeyboard = (list) => ({
  keyboard: [[{ text: "⚙️ Choose alerts", web_app: { url: `${MINI_APP_URL}#f=${list.join(",")}` } }]],
  resize_keyboard: true,
  is_persistent: true,
});

// The bot's Menu button (left of the text box) lists these. Sent once; bump the version to resend.
const BOT_COMMANDS = [
  { command: "trackers", description: "Choose trackers and categories" },
  { command: "all", description: "Follow everything" },
  { command: "start", description: "Subscribe" },
  { command: "stop", description: "Unsubscribe" },
];
const COMMANDS_VERSION = 2;

async function setupMenu(state) {
  if (state.telegram.commandsVersion === COMMANDS_VERSION) return;
  await tg("setMyCommands", { commands: BOT_COMMANDS });
  await tg("setChatMenuButton", { menu_button: { type: "commands" } });
  state.telegram.commandsVersion = COMMANDS_VERSION;
}

// Applies a command, or the Mini App's choice (cmd "app"), to the subscriber list. Returns the
// reply and whether it carries the Mini App keyboard, or null for input the bot ignores.
function handle(subs, id, cmd, chosen) {
  const known = cmd === "/start" || cmd === "/all" || cmd === "/trackers" || cmd === "app" || TRACKER_COMMANDS[cmd];
  if (cmd === "/stop") {
    delete subs[id];
    return { text: "You're unsubscribed. Send /start any time to subscribe again." };
  }
  if (known && !subs[id] && Object.keys(subs).length >= MAX_SUBSCRIBERS) return { text: "Sorry, this bot is full right now." };
  if (cmd === "/start") {
    subs[id] ??= [...DEFAULT_FOLLOW];
    return { text: "✅ You're subscribed. I'll message you when a new programme opens in the categories you follow.\n\n"
      + trackerMenu(subs[id]), app: true };
  }
  if (cmd === "/trackers") subs[id] ??= [...DEFAULT_FOLLOW];
  else if (cmd === "/all") subs[id] = Object.keys(TRACKERS);
  else if (cmd === "app") subs[id] = normalize(chosen);
  else if (TRACKER_COMMANDS[cmd]) {
    // Following any part of a tracker: the command switches all of it off; otherwise all on.
    const t = TRACKER_COMMANDS[cmd];
    const mine = subs[id] ?? [];
    const rest = mine.filter((x) => x !== t && TRACKER_OF[x] !== t);
    subs[id] = rest.length < mine.length ? rest : normalize([...mine, t]);
  } else return null;
  return { text: trackerMenu(subs[id]), app: true };
}

// The Mini App sends a JSON list of trackers and categories; anything else counts as nothing.
function appChoice(data) {
  try {
    const list = JSON.parse(data);
    return Array.isArray(list) ? list.filter((x) => typeof x === "string") : null;
  } catch {
    return null;
  }
}

async function syncTelegramSubscribers(state) {
  if (!TOKEN || DRY_RUN) return;
  const subs = subscribersOrThrow(state);
  await setupMenu(state).catch((e) => console.error("menu setup failed:", e.message));
  const updates = await tg("getUpdates", { offset: state.telegram.offset, timeout: 0, allowed_updates: ["message", "callback_query"] });
  for (const u of updates) {
    state.telegram.offset = u.update_id + 1;
    const q = u.callback_query;
    const m = q ? q.message : u.message;
    if (m?.chat?.type !== "private") continue;
    const id = String(m.chat.id);
    let cmd, chosen;
    if (q) {
      // Tracker buttons on menus sent before the Mini App. Updates are read every 5 minutes, so
      // the press is often too old to answer; the reply is a fresh menu.
      const d = String(q.data ?? "");
      cmd = d === "all" ? "/all" : d === "stop" ? "/stop" : d.startsWith("t:") && TRACKERS[d.slice(2)] ? command(d.slice(2)) : "";
      await tg("answerCallbackQuery", { callback_query_id: q.id }).catch(() => {});
    } else if (m.web_app_data) {
      chosen = appChoice(m.web_app_data.data);
      if (!chosen) continue;
      cmd = "app";
    } else {
      if (!m.text) continue;
      cmd = m.text.trim().split(/[\s@]/)[0].toLowerCase();
    }
    const reply = handle(subs, id, cmd, chosen);
    if (!reply) continue;
    const reply_markup = reply.app ? appKeyboard(subs[id]) : { remove_keyboard: true };
    await tg("sendMessage", { chat_id: m.chat.id, text: reply.text, reply_markup }).catch(() => {});
  }
}

const programmeLine = (p) =>
  `🟢 ${p.company?.name ?? p.companyId} — ${p.name}\n${TRACKERS[p.tracker].name} · ${p.type.replace(/-/g, " ")}\n` +
  (p.closingDate ? `Closes ${p.closingDate.slice(0, 10)}\n` : "") +
  (p.url ?? `https://app.the-trackr.com/${p.page}`);

// Sends each recipient the new programmes in the categories they follow, at most 5 per message.
// One failing recipient doesn't stop the others. Returns the ids of programmes that reached at
// least one person, plus those nobody follows (nothing to deliver; they still go into the feed).
async function notify(fresh, state) {
  if (DRY_RUN) {
    console.log("[dry run] would send:\n" + fresh.map(programmeLine).join("\n\n"));
    return new Set(fresh.map((p) => p.id));
  }
  if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  const fixed = (process.env.TELEGRAM_CHAT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const fixedFollow = (process.env.TELEGRAM_CHAT_TRACKERS || DEFAULT_FOLLOW.join(",")).split(",").map((s) => s.trim());
  const subs = subscribersOrThrow(state);
  const recipients = new Map(Object.entries(subs));
  for (const id of fixed) recipients.set(id, fixedFollow);
  const delivered = new Set();
  const followed = new Set();
  const outbox = [];
  for (const [chatId, follows] of recipients) {
    const mine = fresh.filter((p) => wants(follows, p));
    mine.forEach((p) => followed.add(p.id));
    for (let i = 0; i < mine.length; i += 5) outbox.push({ chatId, programmes: mine.slice(i, i + 5) });
  }
  await paced(outbox, async ({ chatId, programmes }) => {
    try {
      const text = `New on Trackr:\n\n${programmes.map(programmeLine).join("\n\n")}`;
      await tg("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
      programmes.forEach((p) => delivered.add(p.id));
    } catch (e) {
      console.error(`failed -> telegram ${chatId}: ${e.message}`);
      // Someone who blocked the bot or deleted the chat is dropped. Other errors (e.g. a bad
      // message) are not their fault, so they stay subscribed.
      const gone = e.status === 403 || (e.status === 400 && /chat not found|user is deactivated/i.test(e.description));
      if (gone && !fixed.includes(chatId)) delete state.telegram.subscribers[chatId];
    }
  });
  for (const p of fresh) if (!followed.has(p.id)) delivered.add(p.id);
  return delivered;
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
  const subs = state.telegram.subscribers;
  const text =
    `✅ Trackr bot is running.\n${Object.keys(state.open).length} programmes seen open so far, ` +
    `${subs ? Object.keys(subs).length : "?"} subscriber(s), ${WATCH.length} trackers watched.\n` +
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
  let fetched;
  try {
    fetched = await fetchAll(browser);
  } finally {
    await browser.close();
  }
  const { results, errors } = fetched;
  const total = results.reduce((n, r) => n + r.list.length, 0);
  // Zero programmes across every tab almost always means the site changed or blocked us, not
  // that everything vanished. Fail loudly instead of quietly finding nothing new.
  if (!errors.length && !total) throw new Error(`Trackr returned 0 programmes across ${results.length} tabs`);
  if (!results.length) throw errors[0];

  // A tab's first check only records what's already open, so nobody gets 100 messages. After that
  // a programme only counts as seen once its message reached someone who follows its tracker.
  const fresh = new Map();
  const quiet = new Set();
  for (const { tracker, path, list } of results) {
    const first = !state.initialised || !state.pages[path];
    for (const p of list) {
      if (!isOpen(p, now) || state.open[p.id] || fresh.has(p.id)) continue;
      if (first) quiet.add(p.id);
      else fresh.set(p.id, { ...p, tracker, page: path, type: path.split("/").pop() });
    }
  }
  for (const id of quiet) if (!fresh.has(id)) state.open[id] = now.toISOString();
  for (const { path } of results) state.pages[path] = true;
  state.initialised = true;
  console.log(`${fresh.size} newly open programme(s), ${quiet.size} recorded silently`);

  if (fresh.size) {
    const list = [...fresh.values()];
    const delivered = await notify(list, state);
    const sent = list.filter((p) => delivered.has(p.id));
    for (const p of sent) state.open[p.id] = now.toISOString();
    await appendFeed(sent, now.toISOString());
    await saveState(state);
    if (sent.length < list.length) throw new Error(`Every notification failed for ${list.length - sent.length} programme(s)`);
  }
  await saveState(state);
  if (errors.length) throw new Error(`${errors.length} Trackr tab(s) failed: ${errors.map((e) => e.message).join("; ")}`);
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
