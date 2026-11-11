# tolc-watch

Watches https://testcisia.it/calendario.php?tolc=cents&lingua=inglese and alerts you the moment TOLC CEnT-S test dates are released.

## How it works

Each check fetches the page with normal Chrome headers and parses the calendar table row by row. Each row is one exam session, identified by mode + university + city + test date. The checker compares sessions with the previous check (stored in `state.json`) and alerts on:

| Change | Alert |
| --- | --- |
| New exam date / session appears | 🚨 priority 2 (Pushover emergency, repeats until acknowledged) |
| A sold-out session has seats again | 🟢 priority 1 |
| Registration deadline of a session changes | 🕒 priority 0 |
| Session disappears before its registration deadline | ❌ priority 0 |

These changes are logged but do **not** alert, because they happen all the time and used to cause false "schedule updated" alerts: seat counts going up or down, a session selling out, and a session disappearing after its registration deadline has passed.

If the page has neither a calendar table nor the `Nessuna data disponibile` notice, the layout has probably changed: the check counts as a failure, and after 5 consecutive failures you get one "Watcher is failing" alert.

### Check frequency

GitHub delays or drops scheduled runs heavily (gaps of 4–7 hours were observed with a `*/5` cron). So each workflow run loops for about 5h45m, checking every 2 minutes, and commits `state.json` only when something changed (plus an hourly `checkedAt` heartbeat). The cron (`7,37 * * * *`) only restarts the loop; a trigger that fires while a loop is running waits in the queue. This uses a lot of Actions minutes, which is free for public repositories only.

Undelivered Telegram/email messages are kept in `telegram-queue.json` / `email-queue.json` and retried on the next check.

## Local setup

```powershell
# clone the repo
git clone <your-repo-url>
cd tolc-watch

# install dependencies (uses the committed package-lock.json)
npm.cmd ci

# create your local secrets file
copy .env.example .env
# edit .env and fill in the values for the providers you use
```

`state.json` is created automatically on the first run and IS tracked by git (it is not in `.gitignore`). `telegram-queue.json` is also tracked so the workflow can retry failed Telegram deliveries; it contains recipient chat IDs, so keep the repository private if that matters to you. `email-queue.json` is tracked too, but it never stores recipient email addresses (they are read from `EMAIL_RECIPIENTS` at send time). Never commit `.env`.

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
$env:SMTP_USER="your.address@gmail.com"
$env:SMTP_PASSWORD="your_gmail_app_password"
$env:EMAIL_RECIPIENTS="email1@gmail.com,email2@gmail.com"
```

Then send a priority 0 test message to every enabled provider:

```powershell
npm.cmd run test:notify
# or: node check-tolc.js --test
```

Send a test email only (uses the same Gmail SMTP configuration as production):

```powershell
npm.cmd run test:email
# or: node check-tolc.js --send-test-email
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

To check fetch/extraction **without** sending notifications or touching `state.json`:

```powershell
node check-tolc.js --dry-run
```

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
   - `SMTP_USER` (optional — Gmail address used to send email)
   - `SMTP_PASSWORD` (optional — Gmail **App Password**, not your account password)
   - `EMAIL_RECIPIENTS` (optional — comma-separated recipient addresses)

## Run the workflow manually

1. On GitHub, go to **Actions** → **TOLC Watch** → **Run workflow**.
2. Leave both options unchecked for a normal check (updates `state.json`, alerts only on changes).
3. Check **force_alert** to send one real priority-2 (emergency) alert listing the current sessions. `state.json` is not touched.
4. Check **test_notification** to send a test message instead of checking the website.
5. Check **test_email** to send a test email via Gmail SMTP instead of checking the website.

A normal run (scheduled, or manual with all options unchecked) keeps checking every 2 minutes for about 5h45m; see "Check frequency" above. A final `if: always()` step commits `state.json`, `telegram-queue.json` and `email-queue.json` when they change and leaves the job failed when the script exits 1.

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
`telegram-queue.json`, which the workflow commits, and is retried automatically
on the next run, so nothing is lost after a restart.

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

## Gmail SMTP email notifications

TOLC Watch can email you when a change is detected, in addition to (or instead
of) the other notifiers. Email is sent with Nodemailer over
`smtp.gmail.com:465` using a Gmail App Password.

### Setup

1. Enable 2-Step Verification on your Google account.
2. Create an **App Password** at <https://myaccount.google.com/apppasswords>.
3. Configure:
   - `SMTP_USER` — the Gmail address that sends the email.
   - `SMTP_PASSWORD` — the 16-character App Password (not your account password).
   - `EMAIL_RECIPIENTS` — comma-separated recipients, e.g. `email1@gmail.com,email2@gmail.com`.
4. Set them in `.env` locally or as GitHub repository secrets for the workflow.

All recipients are placed in **BCC**, so they cannot see each other's addresses.
The email is a responsive HTML message with a plain-text alternative, the
website name, update details, the detection time in **Asia/Dhaka**, a
"View Website Update" button and the footer "Automated Website Monitoring
System". Untrusted page content is HTML-escaped.

### Reliability

- Email and Telegram are sent in parallel: one failing never blocks the other.
- If email credentials are missing, email is skipped and monitoring continues.
- Failed emails are stored in `email-queue.json` (committed by the workflow) and
  retried on the next run; already-delivered emails are not resent.
- The SMTP password is never logged and is redacted from error messages.

## Files

| File | Purpose |
| --- | --- |
| `check-tolc.js` | Watcher: fetch, extract, compare state, alert |
| `notify.js` | Pushover + CallMeBot + Telegram + email notifiers |
| `telegram.js` | Telegram Bot API client + persistent delivery queue |
| `email.js` | Gmail SMTP (Nodemailer) email notifier + persistent delivery queue |
| `state.json` | Persisted watcher state (created on first run) |
| `telegram-queue.json` | Telegram delivery queue (pending/sent/failed; committed by the workflow) |
| `email-queue.json` | Email delivery queue (pending/sent/failed; committed by the workflow) |
| `test-telegram.js` / `test-email.js` | Offline test suites (`npm test`) |
| `package.json` / `package-lock.json` | Node project, ES modules, `cheerio` + `nodemailer` dependencies |
| `.env` | Local secrets (create from `.env.example`, never commit) |
| `.env.example` | Template with the variable names |
| `.github/workflows/tolc-watch.yml` | GitHub Actions: schedule + manual dispatch |
