# tolc-watch

Watches https://testcisia.it/calendario.php?tolc=cents&lingua=inglese and alerts you the moment TOLC CEnT-S test dates are released.

## How it works

Each run fetches the server-rendered page with normal Chrome headers, strips `<script>`/`<style>` tags, collapses whitespace, and extracts the calendar section between `CALENDARIO ISCRIZIONI APERTE` and `CISIA - Via`.

- **No dates yet:** the page contains `Nessuna data disponibile CEnT-S 2026` → no alert.
- **Dates released:** that phrase disappears → `DATES RELEASED` alert (Pushover priority 2: retries every 60s for up to 1 hour until acknowledged).
- **Hash changed but no date flip:** `Calendar changed` alert.
- **Dates removed:** `Dates removed` alert.

State is persisted in `state.json` (SHA-256 hash, `hasDates`, `failCount`, `failAlerted`, `checkedAt`) and compared between runs.

## Local setup

```powershell
# clone the repo
git clone <your-repo-url>
cd tolc-watch

# install dependencies (uses the committed package-lock.json)
npm.cmd ci

# create your local secrets file
copy .env.example .env
# edit .env and fill in the four values
```

`state.json` is created automatically on the first run and IS tracked by git (it is not in `.gitignore`). Never commit `.env`.

## Set environment variables and run a test (PowerShell)

For the current PowerShell session:

```powershell
$env:PUSHOVER_TOKEN="your_token"
$env:PUSHOVER_USER="your_user_key"
$env:CALLMEBOT_PHONE="+393xxxxxxxxxx"
$env:CALLMEBOT_APIKEY="your_apikey"
$env:TELEGRAM_BOT_TOKEN="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
$env:TELEGRAM_ALLOWED_CHAT_IDS="123456789,-987654321"
$env:TELEGRAM_NOTIFICATIONS_ENABLED=true
```

Then send a priority 0 test message to every enabled provider:

```powershell
npm.cmd run test:notify
# or: node check-tolc.js --test
```

To make variables persistent across sessions:

```powershell
[System.Environment]::SetEnvironmentVariable('PUSHOVER_TOKEN', 'your_token', 'User')
# repeat for PUSHOVER_USER, CALLMEBOT_PHONE, CALLMEBOT_APIKEY
```

## Verify fetching without sending notifications

```powershell
node check-tolc.js
```

Run with no secrets configured: it fetches the page, logs the extraction result, updates `state.json`, and sends no notifications. Use this to confirm the fetch/extraction works before configuring notifiers.

## Push to GitHub

```powershell
git add -A
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<your-user>/<your-repo>.git
git push -u origin main
```

Commit `package-lock.json` as well — the workflow installs with `npm ci`.

## Add the secrets to GitHub

1. On GitHub, go to your repository → **Settings** → **Secrets and variables** → **Actions**.
2. Click **New repository secret** and add each of these:
   - `PUSHOVER_TOKEN`
   - `PUSHOVER_USER`
   - `CALLMEBOT_PHONE`
   - `CALLMEBOT_APIKEY`
   - `TELEGRAM_BOT_TOKEN` (optional — Telegram notifications)
   - `TELEGRAM_ALLOWED_CHAT_IDS` (optional — comma-separated Telegram chat IDs)
   - `TELEGRAM_NOTIFICATIONS_ENABLED` (optional — `true`/`false`, default `true`)

## Run the workflow manually

1. On GitHub, go to **Actions** → **TOLC Watch** → **Run workflow**.
2. Leave `force_alert` unchecked for a normal check (updates `state.json`, alerts only on changes).
3. Check **force_alert** to send one real priority-2 (emergency) alert with the current extracted text. `state.json` is not touched.

The workflow also runs automatically on schedule `*/10 * * * *` (every 10 minutes). A final `if: always()` step commits `state.json` when it changed and leaves the job failed when the script exits 1.

## Acknowledge a Pushover emergency alert

`DATES RELEASED` alerts use Pushover priority 2 (`retry=60`, `expire=3600`): Pushover retries every 60 seconds for up to 1 hour until you acknowledge.

1. Open the Pushover notification on your device.
2. Tap **Acknowledge** to stop the repeat notifications.

## Telegram Bot notifications

TOLC Watch can send release alerts to Telegram via the official Bot API
(`https://api.telegram.org/bot<TOKEN>/sendMessage`). Everything is
server-side: the bot token is read from environment variables, never logged,
and never exposed anywhere else.

### Setup

1. **Create the bot:** message [@BotFather](https://t.me/botfather) on Telegram,
   run `/newbot`, and copy the bot token.
2. **Get chat IDs:** send the bot any message, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` in your browser. Look for
   `"chat":{"id":123456789,...}`. For a group, add the bot to the group and
   repeat the step (group IDs are negative).
3. **Configure:** set `TELEGRAM_BOT_TOKEN` and
   `TELEGRAM_ALLOWED_CHAT_IDS` (comma-separated list, e.g.
   `123456789,-987654321`) in `.env` (local) or as GitHub repository secrets
   (workflow). `TELEGRAM_NOTIFICATIONS_ENABLED=true` enables the notifier.
4. **Test:** run `npm.cmd run test:notify` (`node check-tolc.js --test`) — a
   test message is sent to every enabled provider, including Telegram.

### Multiple recipients

Each chat ID in `TELEGRAM_ALLOWED_CHAT_IDS` receives its own message. If one
recipient fails (invalid chat ID, rate limit, …), the others are still
notified. There is no self-service subscription: only the chat IDs in the
allowlist are notified, which keeps the watchlist private by design.

To add or remove a recipient, edit `TELEGRAM_ALLOWED_CHAT_IDS` and redeploy
(or restart the workflow). Delivery state (pending/sent/failed) is kept in
`telegram-queue.json` and retried automatically on the next run, so nothing is
lost after a restart.

### Automatic release notifications

When the watcher detects a genuine change (new dates, dates removed, or any
calendar change), it:

1. Verifies the change against the previously stored `state.json` hash.
2. Builds a Telegram message with the website, release title, detection time
   (**Asia/Dhaka timezone**) and release URL.
3. Deduplicates the notification per release and recipient so the same release
   is never delivered twice.
4. Sends the message to every enabled recipient with retries and exponential
   backoff (honouring Telegram's HTTP 429 rate limits).
5. Records the delivery result in `telegram-queue.json`.

Example message:

```text
🚨 NEW RELEASE DETECTED!

🌐 Website: TOLC Watch
📢 Release: DATES RELEASED
🕒 Detected: 29 Oct 2026, 11:30 AM (Asia/Dhaka)

🔗 View Release:
https://testcisia.it/calendario.php?tolc=cents&lingua=inglese
```

### Security

- The bot token is server-only: it is never logged and never sent to a frontend (this project has no frontend).
- Messages are sent without `parse_mode`, so they are plain text — page content can not inject Markdown/HTML.
- Chat IDs are validated (`^-?\d+$`) and deduplicated; arbitrary users cannot subscribe.
- Admin/API access is not applicable: this is a single-purpose watcher with no public endpoints.

## Files

| File | Purpose |
| --- | --- |
| `check-tolc.js` | Watcher: fetch, extract, compare state, alert |
| `notify.js` | Pushover + CallMeBot + Telegram notifiers |
| `telegram.js` | Telegram Bot API client + persistent delivery queue |
| `state.json` | Persisted watcher state (created on first run) |
| `telegram-queue.json` | Telegram delivery queue (pending/sent/failed; runtime only) |
| `package.json` / `package-lock.json` | Node project, ES modules, `cheerio` dependency |
| `.env` | Local secrets (create from `.env.example`, never commit) |
| `.env.example` | Template with the variable names |
| `.github/workflows/tolc-watch.yml` | GitHub Actions: schedule + manual dispatch |
