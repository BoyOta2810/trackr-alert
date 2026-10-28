// Checks Trackr's UK Finance tracker and sends a WhatsApp and/or Telegram
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

// Recipients are read from environment variables (GitHub secrets), never from the repo.
//   WHATSAPP_RECIPIENTS = "+447700900123:apikey1,+447700900456:apikey2"   (CallMeBot)
//   TELEGRAM_BOT_TOKEN  = token from @BotFather
//   TELEGRAM_CHAT_IDS   = "111111111,222222222"                           (everyone who pressed Start)
// The older CALLMEBOT_PHONE / CALLMEBOT_APIKEY pair still works for a single WhatsApp number.
function whatsappRecipients() {
  const list = (process.env.WHATSAPP_RECIPIENTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.lastIndexOf(":");
      return { phone: s.slice(0, i), apikey: s.slice(i + 1) };
    });
  const { CALLMEBOT_PHONE, CALLMEBOT_APIKEY } = process.env;
  if (CALLMEBOT_PHONE && CALLMEBOT_APIKEY) list.push({ phone: CALLMEBOT_PHONE, apikey: CALLMEBOT_APIKEY });
  return list;
}

function telegramRecipients() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const ids = (process.env.TELEGRAM_CHAT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return token ? ids.map((chatId) => ({ token, chatId })) : [];
}

async function sendWhatsApp({ phone, apikey }, text) {
  const url = "https://api.callmebot.com/whatsapp.php?" + new URLSearchParams({ phone, text, apikey });
  const r = await fetch(url);
  if (!r.ok) throw new Error(`CallMeBot ${r.status}: ${await r.text()}`);
}

async function sendTelegram({ token, chatId }, text) {
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error(`Telegram ${r.status}: ${await r.text()}`);
}

// Sends to every configured recipient. One failing recipient doesn't stop the others.
// Throws only if nothing was delivered, so the programmes stay "unseen" and are retried next run.
async function notify(text) {
  if (DRY_RUN) return console.log("[dry run] would send:\n" + text);
  const jobs = [
    ...whatsappRecipients().map((r) => ({ name: "whatsapp " + r.phone.slice(0, 4) + "…", run: () => sendWhatsApp(r, text) })),
    ...telegramRecipients().map((r) => ({ name: "telegram " + r.chatId, run: () => sendTelegram(r, text) })),
  ];
  if (!jobs.length) throw new Error("No recipients configured (see README)");
  const results = await Promise.allSettled(jobs.map((j) => j.run()));
  results.forEach((res, i) => {
    if (res.status === "rejected") console.error(`failed -> ${jobs[i].name}: ${res.reason.message}`);
  });
  if (results.every((r) => r.status === "rejected")) throw new Error("Every notification failed");
}

const state = await loadState();
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
  // CallMeBot messages are best kept short, so send in chunks.
  for (let i = 0; i < newlyOpen.length; i += 5) {
    const lines = newlyOpen.slice(i, i + 5).map(
      (p) =>
        `🟢 ${p.company?.name ?? p.companyId} — ${p.name}\n` +
        (p.closingDate ? `Closes ${p.closingDate.slice(0, 10)}\n` : "") +
        (p.url ?? `https://app.the-trackr.com/uk-finance/${p.type}`),
    );
    await notify(`New on Trackr UK Finance:\n\n${lines.join("\n\n")}`);
  }
}

state.initialised = true;
await fs.mkdir(new URL("./state/", import.meta.url), { recursive: true });
await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
