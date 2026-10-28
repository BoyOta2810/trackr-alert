# Trackr → Telegram alert

Every 5 minutes, checks the Trackr UK Finance tracker (app.the-trackr.com/uk-finance)
and sends a **Telegram** message when a programme opens.

The bot is **public**: anyone who opens it and presses **Start** gets the alerts, and `/stop`
unsubscribes. Nobody has to look up chat IDs. Runs free on GitHub Actions.

## For users
Open the bot in Telegram and press **Start**. You'll get a confirmation within about 5-15 minutes
(the bot checks for new subscribers on each run), then a message whenever a new programme opens.
Send `/stop` to unsubscribe.

## Set up your own copy (about 5 minutes)

### 1. Fork this repo
Keep it **public**: public repos get unlimited free Actions minutes. A private repo would use
roughly 9,000 of its 2,000 free minutes a month at this schedule.

### 2. Create the bot
In Telegram, message **@BotFather** → `/newbot` → choose a name → copy the **token**.

### 3. Add the token as a secret
Repo → Settings → Secrets and variables → Actions → **New repository secret**:

| Kind     | Name                 | Value                                              |
|----------|----------------------|----------------------------------------------------|
| Secret   | `TELEGRAM_BOT_TOKEN` | the token from @BotFather                          |
| Secret   | `TELEGRAM_CHAT_IDS`  | optional: always-on extras, e.g. a channel or group ID |
| Variable | `TRACKR_TYPES`       | optional, see below                                |

Never commit the token. Anyone with it can control the bot.

### 4. Run it once
Actions tab → **Trackr check** → **Run workflow**. The first run only records what's already
open, so you don't get a flood of messages. After that it runs every 5 minutes by itself.

## Which tabs to watch
`TRACKR_TYPES` is a comma-separated list. The default is `summer-internships`.

`summer-internships`, `spring-weeks`, `off-cycle-internships`, `industrial-placements`,
`graduate-programmes`

Example: `summer-internships,off-cycle-internships`

The season defaults to `2027`; override it with the `TRACKR_SEASON` environment variable in the workflow.

## Privacy and limits
- Subscribers' Telegram **chat IDs** (numbers, no names or phone numbers) are stored in
  `state/seen.json`, which is **public** in a public repo. Don't use this for anything sensitive.
- The list is capped at 200 subscribers (`MAX_SUBSCRIBERS`). People who block the bot are removed
  automatically.

## Notes
- **Timing:** GitHub sometimes runs scheduled jobs 5-15 minutes late when it's busy. For exact
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
