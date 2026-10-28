// Checks Trackr's UK Finance tracker and sends a Telegram
// message when a programme opens. Loads the page in a real headless browser and reads the
// programme list the page itself fetches.
import { chromium } from "playwright";
import fs from "node:fs/promises";

const TYPES = (process.env.TRACKR_TYPES || "summer-internships").split(",").map((s) => s.trim());
const SEASON = process.env.TRACKR_SEASON || "2027";
const STATE_FILE = new URL("./state/seen.json", import.meta.url);
const DRY_RUN = process.env.DRY_RUN === "1";

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
  } catch {
    return { initialised: false, open: {} };
  }
}

async function fetchProgrammes(page, type) {
  const resp = page.waitForResponse(
    (r) => r.url().includes("/programmes?") && r.url().includes(`type=${type}`) && r.status() === 200,
    { timeout: 60_000 },
  );
  await page.goto(`https://app.the-trackr.com/uk-finance/${type}`, { waitUntil: "domcontentloaded" });
  const body = await (await resp).json();
  return body.programmes.filter((p) => p.season === SEASON);
}

function isOpen(p, now) {
  if (!p.openingDate || new Date(p.openingDate) > now) return false;
  return !p.closingDate || new Date(p.closingDate) >= now;
}

// ---- Telegram ------------------------------------------------------------
// The bot is public: anyone who opens it and presses Start is subscribed, /stop unsubscribes.
// Subscribers are remembered in state/seen.json. TELEGRAM_CHAT_IDS (optional) are always-on extras,
// e.g. a channel or group. Each 5-minute run reads new Start/Stop messages, so a new subscriber is
// confirmed within about 5-15 minutes.
const MAX_SUBSCRIBERS = Number(process.env.MAX_SUBSCRIBERS || 200);

async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) {
    const err = new Error(`Telegram ${method} ${r.status}: ${j.description ?? ""}`);
    err.status = r.status;
    throw err;
  }
  return j.result;
}

async function syncTelegramSubscribers(state) {
  if (!process.env.TELEGRAM_BOT_TOKEN || DRY_RUN) return;
  state.telegram ??= { offset: 0, subscribers: [] };
  const subs = new Set(state.telegram.subscribers);
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

function telegramRecipients(state) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return [];
  const fixed = (process.env.TELEGRAM_CHAT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const subs = state.telegram?.subscribers ?? [];
  return [...new Set([...fixed, ...subs])].map((chatId) => ({ chatId, subscriber: subs.includes(chatId) && !fixed.includes(chatId) }));
}

// Sends to every configured recipient. One failing recipient doesn't stop the others.
// Throws only if nothing was delivered, so the programmes stay "unseen" and are retried next run.
async function notify(text, state) {
  if (DRY_RUN) return console.log("[dry run] would send:\n" + text);
  const jobs = [
    ...telegramRecipients(state).map((r) => ({
      name: "telegram " + r.chatId,
      run: () => tg("sendMessage", { chat_id: r.chatId, text, disable_web_page_preview: true }),
      subscriber: r.subscriber,
      chatId: r.chatId,
    })),
  ];
  if (!jobs.length) return console.warn("No recipients yet: nobody has pressed Start on the bot.");
  const results = await Promise.allSettled(jobs.map((j) => j.run()));
  results.forEach((res, i) => {
    if (res.status !== "rejected") return;
    console.error(`failed -> ${jobs[i].name}: ${res.reason.message}`);
    // Someone who blocked the bot or deleted the chat is dropped from the list.
    if (jobs[i].subscriber && [400, 403].includes(res.reason.status)) {
      state.telegram.subscribers = state.telegram.subscribers.filter((id) => id !== jobs[i].chatId);
    }
  });
  if (results.every((r) => r.status === "rejected")) throw new Error("Every notification failed");
}

async function saveState(state) {
  await fs.mkdir(new URL("./state/", import.meta.url), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

const state = await loadState();
await syncTelegramSubscribers(state);
await saveState(state); // keep the Telegram offset even if the site check fails below
const now = new Date();
const browser = await chromium.launch();
const page = await browser.newPage();
const newlyOpen = [];

try {
  for (const type of TYPES) {
    for (const p of await fetchProgrammes(page, type)) {
      if (!isOpen(p, now) || state.open[p.id]) continue;
      state.open[p.id] = now.toISOString();
      newlyOpen.push({ ...p, type });
    }
  }
} finally {
  await browser.close();
}

console.log(`${newlyOpen.length} newly open programme(s)`);

// First run only records what's already open, so you don't get 100 messages.
if (state.initialised && newlyOpen.length) {
  // Keep messages short: send in chunks of 5.
  for (let i = 0; i < newlyOpen.length; i += 5) {
    const lines = newlyOpen.slice(i, i + 5).map(
      (p) =>
        `🟢 ${p.company?.name ?? p.companyId} — ${p.name}\n` +
        (p.closingDate ? `Closes ${p.closingDate.slice(0, 10)}\n` : "") +
        (p.url ?? `https://app.the-trackr.com/uk-finance/${p.type}`),
    );
    await notify(`New on Trackr UK Finance:\n\n${lines.join("\n\n")}`, state);
  }
}

state.initialised = true;
await saveState(state);
