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

## Add the 4 secrets to GitHub

1. On GitHub, go to your repository → **Settings** → **Secrets and variables** → **Actions**.
2. Click **New repository secret** and add each of these:
   - `PUSHOVER_TOKEN`
   - `PUSHOVER_USER`
   - `CALLMEBOT_PHONE`
   - `CALLMEBOT_APIKEY`

## Run the workflow manually

1. On GitHub, go to **Actions** → **TOLC Watch** → **Run workflow**.
2. Leave `force_alert` unchecked for a normal check (updates `state.json`, alerts only on changes).
3. Check **force_alert** to send one real priority-2 (emergency) alert with the current extracted text. `state.json` is not touched.

The workflow also runs automatically on schedule `*/10 * * * *` (every 10 minutes). A final `if: always()` step commits `state.json` when it changed and leaves the job failed when the script exits 1.

## Acknowledge a Pushover emergency alert

`DATES RELEASED` alerts use Pushover priority 2 (`retry=60`, `expire=3600`): Pushover retries every 60 seconds for up to 1 hour until you acknowledge.

1. Open the Pushover notification on your device.
2. Tap **Acknowledge** to stop the repeat notifications.

## Files

| File | Purpose |
| --- | --- |
| `check-tolc.js` | Watcher: fetch, extract, compare state, alert |
| `notify.js` | Pushover + CallMeBot notifiers |
| `state.json` | Persisted watcher state (created on first run) |
| `package.json` / `package-lock.json` | Node project, ES modules, `cheerio` dependency |
| `.env` | Local secrets (create from `.env.example`, never commit) |
| `.env.example` | Template with the 4 variable names |
| `.github/workflows/tolc-watch.yml` | GitHub Actions: schedule + manual dispatch |
