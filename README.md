# Trackr → WhatsApp / Telegram alert

Every 5 minutes, checks the Trackr UK Finance tracker (app.the-trackr.com/uk-finance)
and messages you on **WhatsApp and/or Telegram** when a programme opens. Any number of people
can receive the alerts.

Runs free on GitHub Actions. State lives in `state/seen.json`, and the workflow commits it back
to the repo after each run. No secrets are stored in the repo: phone numbers, API keys and bot
tokens go in GitHub Actions secrets.

## Setup (about 10 minutes)

### 1. Fork or clone this repo
Public repos get unlimited free Actions minutes. A private repo would use roughly 9,000 of its
2,000 free minutes a month at this schedule, so keep it public.

### 2. Pick a channel (or both)

**Telegram (easiest, most reliable)**
1. In Telegram, message **@BotFather** → `/newbot` → copy the bot **token**.
2. Everyone who wants alerts opens the new bot and presses **Start**.
3. Get each person's chat ID: message **@userinfobot** (it replies with your numeric ID), or open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` after pressing Start and read `chat.id`.

**WhatsApp (CallMeBot, free)**
Each person does this for their own number:
1. Save **+34 644 51 95 23** in your contacts (check
   https://www.callmebot.com/blog/free-api-whatsapp-messages/ in case it has changed).
2. Send it this WhatsApp message: `I allow callmebot to send me messages`
3. It replies with your **apikey**.

### 3. Add secrets
Repo → Settings → Secrets and variables → Actions → **New repository secret**:

| Kind     | Name                  | Value                                                                   |
|----------|-----------------------|-------------------------------------------------------------------------|
| Secret   | `TELEGRAM_BOT_TOKEN`  | token from @BotFather                                                   |
| Secret   | `TELEGRAM_CHAT_IDS`   | comma-separated chat IDs, e.g. `111111111,222222222`                    |
| Secret   | `WHATSAPP_RECIPIENTS` | comma-separated `number:apikey` pairs, e.g. `+447700900123:111111,+998901234567:222222` |
| Variable | `TRACKR_TYPES`        | optional, see below                                                     |

You only need the Telegram secrets or the WhatsApp secret, not both. Numbers include the country
code. (The older `CALLMEBOT_PHONE` / `CALLMEBOT_APIKEY` pair still works for one number.)

### 4. Run it once
Actions tab → **Trackr check** → **Run workflow**. The first run only records what's already
open, so you don't get a flood of messages. After that it runs every 5 minutes by itself.

## Which tabs to watch
`TRACKR_TYPES` is a comma-separated list. The default is `summer-internships`.

`summer-internships`, `spring-weeks`, `off-cycle-internships`, `industrial-placements`,
`graduate-programmes`

Example: `summer-internships,off-cycle-internships`

The season defaults to `2027`; override it with the `TRACKR_SEASON` environment variable in the workflow.

## Notes
- **Timing:** GitHub sometimes runs scheduled jobs 5–15 minutes late when it's busy. For exact
  5-minute timing, use a free cron-job.org job that calls GitHub's
  `workflow_dispatch` API every 5 minutes.
- **Keeps itself alive:** GitHub pauses scheduled workflows in repos with no activity for 60 days.
  The state commits count as activity while programmes are changing; if alerts stop, re-enable the
  workflow in the Actions tab.
- **Why not Vercel:** Vercel's free plan only runs cron jobs once a day, and a headless browser
  is hard to fit into a Vercel function.
- **Why a headless browser:** Trackr only returns data after a browser session check. The script
  loads the page normally and reads the list the page fetches. It doesn't call the API directly.
- **Local test without sending:** `npm install && npx playwright install chromium && DRY_RUN=1 npm run check`
- Unofficial tool, not affiliated with Trackr. Be considerate: don't lower the interval below 5 minutes.
