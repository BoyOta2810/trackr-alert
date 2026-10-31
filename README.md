# Trackr → Telegram alert

Checks the Trackr UK Finance tracker (app.the-trackr.com/uk-finance) about every 5 minutes and
sends a **Telegram** message when a programme opens.

The bot is **public**: anyone who opens it and presses **Start** gets the alerts, and `/stop`
unsubscribes. Runs free on GitHub Actions.

## For users
Open the bot in Telegram and press **Start**. You'll get a confirmation within about 5-10 minutes
(the bot reads new Start/Stop messages on each check), then a message whenever a new programme
opens. Send `/stop` to unsubscribe.

## How it runs
- **Trigger:** a free Cloudflare Worker (`worker/`) calls GitHub's `workflow_dispatch` API every
  5 minutes. GitHub's own cron is kept as a 15-minute fallback; it skips itself if a check
  succeeded in the last 4 minutes. GitHub's cron alone is not reliable: it once left a 5.5-hour gap.
- **No overlap:** all runs share one concurrency group, so they queue instead of racing on
  `state/seen.json`. The state commit rebases and retries if the branch moved.
- **Check:** loads the page in headless Chromium (Playwright) and reads the `/programmes` list the
  page itself fetches. Trackr only answers after a browser session check, so it doesn't call the
  API directly.
- **Delivery:** a programme only counts as seen once its message reached at least one person.
  If nobody got it, it's retried on the next run. Telegram rate limits (429) are retried; people
  who block the bot are removed.
- **Feed:** every alerted programme is also added to `state/feed.json`, newest first, at most 300
  entries: id, company, name, type, season, url, trackr_url, opening/closing date, opened_at. It
  holds nothing the alerts don't already say, and no subscriber data. JobPilot reads it from
  `raw.githubusercontent.com` to draft applications automatically.

## Admin messages (`TELEGRAM_ADMIN_IDS`)
- **Daily heartbeat** after 08:00 London time: programmes seen, subscriber count, and how many runs
  the 5-minute trigger started in the last 24h (about 288 expected; near 0 means the Worker stopped).
- **Failure alert** when a run fails, or Trackr returns zero programmes or an unexpected shape
  (likely the site changed or blocked us). One message, a reminder every 6 hours while it stays
  broken, and a "back to normal" message when it recovers.

## Setup

### GitHub (repo → Settings → Secrets and variables → Actions)
| Kind     | Name                 | Value                                                  |
|----------|----------------------|--------------------------------------------------------|
| Secret   | `TELEGRAM_BOT_TOKEN` | the token from @BotFather                              |
| Variable | `TELEGRAM_ADMIN_IDS` | your own Telegram chat ID(s), comma-separated          |
| Secret   | `TELEGRAM_CHAT_IDS`  | optional: always-on extras, e.g. a channel or group ID |
| Variable | `TRACKR_TYPES`       | optional, see below                                    |

Keep the repo **public**: public repos get unlimited free Actions minutes.

### Cloudflare Worker (the 5-minute trigger)
1. On GitHub: Settings → Developer settings → **Fine-grained tokens** → Generate new token.
   Repository access: **Only select repositories → trackr-alert**. Permissions: **Actions: Read
   and write** (Metadata: read-only is added automatically). Nothing else.
2. In `worker/`: `npx wrangler login`, then `npx wrangler deploy`, then
   `npx wrangler secret put GH_TOKEN` and paste the token at the prompt.
   The token lives only in Cloudflare's secret store. Never commit it.
3. When the token expires, create a new one and repeat `wrangler secret put`. Until then the
   15-minute fallback keeps running, and the heartbeat's run count drops to about 0.

### Which tabs to watch
`TRACKR_TYPES` is a comma-separated list. The default is `summer-internships`. Options:
`summer-internships`, `spring-weeks`, `off-cycle-internships`, `industrial-placements`,
`graduate-programmes`. The season defaults to `2027` (`TRACKR_SEASON`).

## Privacy
`state/seen.json` is public. The subscriber list in it is **encrypted** (AES-GCM, key derived from
the bot token), so chat IDs aren't readable. Two caveats:
- Chat IDs stored before encryption remain visible in the git history.
- If you replace the bot token, the old list can't be decrypted. Runs then fail with an admin
  alert and the list is kept untouched, so restoring the old token fixes it.

Capped at 200 subscribers (`MAX_SUBSCRIBERS`).

## Local test
```
npm ci && npx playwright install --only-shell chromium
DRY_RUN=1 node check.mjs   # real site, no Telegram, state not written
npm test                   # offline tests with mocked Trackr and Telegram
```
Don't run it locally without `DRY_RUN` while Actions is running: two bots reading Telegram
updates at once conflict.

Unofficial tool, not affiliated with Trackr. Be considerate: don't lower the interval below 5 minutes.
