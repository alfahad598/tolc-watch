import dotenv from 'dotenv';
dotenv.config();

import { load } from 'cheerio';
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { sendNotification, hasNotificationProvider } from './notify.js';
import { processTelegramQueue } from './telegram.js';
import { processEmailQueue, sendTestEmail } from './email.js';

const URL = 'https://testcisia.it/calendario.php?tolc=cents&lingua=inglese';
const START_MARKER = 'CALENDARIO ISCRIZIONI APERTE';
const END_MARKER = 'CISIA - Via';
const NO_DATES_MARKER = 'Nessuna data disponibile';
const STATE_FILE = 'state.json';
const MIN_TEXT_LEN = 50;
const MAX_TEXT_PREVIEW = 500;
const FETCH_TIMEOUT_MS = 30000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const ACCEPT_LANGUAGE = 'en-US,en;q=0.9';

const args = process.argv.slice(2);
const isTest = args.includes('--test');
const isForceAlert = args.includes('--force-alert');
const isSendTest = args.includes('--send-test');
const isSendTestEmail = args.includes('--send-test-email');
const isStatusAlert = args.includes('--status-alert');
const isDryRun = args.includes('--dry-run');

function log(...msg) {
  console.log(`[${new Date().toISOString()}]`, ...msg);
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function dhakaTime() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function extractText(html) {
  const $ = load(html);
  $('script, style').remove();
  let text = $('body').text();
  text = text.replace(/\s+/g, ' ').trim();
  const si = text.indexOf(START_MARKER);
  const ei = text.indexOf(END_MARKER);
  if (si !== -1 && ei !== -1 && ei > si) {
    text = text.slice(si + START_MARKER.length, ei).trim();
  }
  return text;
}

function blockPageReason(status, html) {
  if (status !== 200) return `HTTP status ${status}`;
  const lower = (html || '').toLowerCase();
  if (/cloudflare|captcha|just a moment|checking your browser/.test(lower)) {
    return 'Cloudflare / CAPTCHA challenge page';
  }
  if (/access denied|forbidden/.test(lower)) return 'Access denied / forbidden page';
  return null;
}

function loadState() {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch (err) {
    log('Warning: could not parse state.json, starting fresh:', err.message);
    return null;
  }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function messageFromText(text) {
  return `${text.slice(0, MAX_TEXT_PREVIEW)}\n\n${URL}`;
}

function releaseMessage(text) {
  const preview = text.slice(0, MAX_TEXT_PREVIEW);
  return `🚨 EXAM SCHEDULE RELEASED!

The monitored exam schedule is now available.

🔗 Official Website: ${URL}
🕒 Detected: ${dhakaTime()}

${preview}`;
}

function changeMessage(text, changeTitle) {
  return `📝 WEBSITE CHANGED — ${changeTitle}

The monitored calendar page has changed.

🔗 Official Website: ${URL}
🕒 Detected: ${dhakaTime()}

${text.slice(0, MAX_TEXT_PREVIEW)}`;
}

function testMessage() {
  return `✅ TOLC WATCH IS ACTIVE!

🔍 Website monitoring initialized.
⏱️ Checking interval: Every 5 minutes.
📡 GitHub Actions: Working.
🔔 Notifications: Connected.

🕒 Test Time: ${dhakaTime()}`;
}

function statusMessage(text, status) {
  const preview = text.slice(0, 200);
  return `✅ TOLC WATCH — LIVE CHECK

🌐 Website: ${URL}
📖 Status: Website is readable (HTTP ${status})
📄 Extracted: ${preview.length} chars
📅 Release available: ${text.includes(NO_DATES_MARKER) ? 'No' : 'Yes'}
🕒 Checked: ${dhakaTime()}`;
}

async function recordFailure(reason) {
  log('ERROR:', reason);
  const prev = loadState() || {};
  const failCount = Number(prev.failCount || 0) + 1;
  let failAlerted = Boolean(prev.failAlerted);

  if (failCount >= 6 && !failAlerted) {
    log('Consecutive failures reached 6; sending one failure alert.');
    try {
      const ok = await sendNotification(`Watcher is failing: ${reason}`, 0, {
        title: 'Watcher is failing',
        url: URL,
      });
      // Only mark as alerted once a provider actually accepted the message,
      // otherwise keep retrying on the next failing run.
      failAlerted = ok;
      log(ok ? 'Failure alert sent.' : 'Failure alert failed; will retry next run.');
    } catch (err) {
      log('Failure alert send threw:', err.message);
    }
  }

  saveState({
    hash: prev.hash || null,
    hasDates: Boolean(prev.hasDates),
    failCount,
    failAlerted,
    checkedAt: new Date().toISOString(),
  });
  process.exit(1);
}

async function main() {
  if (isSendTestEmail) {
    log('Sending test email...');
    const ok = await sendTestEmail();
    console.log(`--send-test-email: ${ok ? 'test email sent' : 'test email failed or not configured'}`);
    process.exit(ok ? 0 : 1);
  }

  if (isSendTest) {
    log('Sending test notification...');
    const ok = await sendNotification(testMessage(), 0, {
      title: 'TOLC WATCH — test',
      url: URL,
      force: true,
    });
    console.log(`--send-test: ${ok ? 'test notification sent' : 'test notification failed (no provider succeeded)'}`);
    process.exit(ok ? 0 : 1);
  }

  if (isTest) {
    log('Running legacy test notification...');
    const ok = await sendNotification(testMessage(), 0, {
      title: 'TOLC Watch — test',
      url: URL,
      force: true,
    });
    console.log(`--test: ${ok ? 'at least one provider succeeded' : 'no provider succeeded/configured'}`);
    process.exit(ok ? 0 : 1);
  }

  log('Monitoring started');
  log(`Target website checked: ${URL}`);

  if (!isDryRun) {
    await processTelegramQueue();
    await processEmailQueue();
  }

  let status;
  let html;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(URL, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': ACCEPT_LANGUAGE,
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    status = res.status;
    html = await res.text();
    log(`HTTP response received: status ${status}`);
  } catch (err) {
    log('HTTP response received: FAILED (network error)');
    await recordFailure(`network error: ${err.message}`);
    return;
  }

  const reason = blockPageReason(status, html);
  if (reason) {
    log('HTTP response received: BLOCKED (' + reason + ')');
    await recordFailure(reason);
    return;
  }

  const text = extractText(html);
  if (!text || text.length < MIN_TEXT_LEN) {
    log('Release detection completed: EXTRACTION FAILED (text too short or empty)');
    await recordFailure(`extraction empty or too short (${text ? text.length : 0} chars)`);
    return;
  }

  const hash = sha256(text);
  const hasDates = !text.includes(NO_DATES_MARKER);
  log('Release detection completed');

  if (isDryRun) {
    log(`--dry-run: HTTP ${status}, ${text.length} chars, hash ${hash.slice(0, 12)}…, hasDates=${hasDates}`);
    log(`--dry-run: preview: ${text.slice(0, MAX_TEXT_PREVIEW)}`);
    process.exit(0);
  }

  // ---- Send live status message every run (confirms website is readable) ----
  if (isStatusAlert) {
    log('Sending live status notification...');
    const ok = await sendNotification(statusMessage(text, status), 0, {
      title: 'TOIC WATCH — Live Check',
      url: URL,
    });
    console.log(`--status-alert: ${ok ? 'status notification sent' : 'status notification failed (no provider succeeded)'}`);
    if (!ok) {
      process.exit(1);
    }
  }

  // ---- --force-alert: send one real priority 2 alert, no state changes ----
  if (isForceAlert) {
    const ok = await sendNotification(releaseMessage(text), 2, {
      title: 'TOLC Watch — forced alert',
      url: URL,
      force: true,
    });
    console.log(`--force-alert: ${ok ? 'alert sent' : 'alert failed (no provider succeeded)'}`);
    process.exit(ok ? 0 : 1);
  }

  // ---- compare with previous state ----
  const state = loadState();
  const providerConfigured = hasNotificationProvider();
  let releaseDetected = false;
  let changeTitle = '';

  if (!state) {
    if (hasDates) {
      releaseDetected = true;
      changeTitle = 'RELEASED';
    }
  } else if (hash !== state.hash) {
    if (!state.hasDates && hasDates) {
      releaseDetected = true;
      changeTitle = 'RELEASED';
    } else if (state.hasDates && !hasDates) {
      changeTitle = 'Dates removed';
    } else {
      changeTitle = 'Calendar changed';
    }
  }

  if (releaseDetected) {
    log('Release status: RELEASED');
    const ok = await sendNotification(releaseMessage(text), 2, {
      title: 'TOLC Watch — Exam Schedule Released',
      url: URL,
      force: isForceAlert,
    });
    if (ok || !providerConfigured) {
      log(ok ? 'Notification status: SENT' : 'Notification status: SKIPPED (no provider configured)');
      saveState({ hash, hasDates, failCount: 0, failAlerted: false, checkedAt: new Date().toISOString() });
      log(`Release alert handled ("${changeTitle}") and state saved.`);
    } else {
      log('Notification status: FAILED');
      log(`Release alert failed ("${changeTitle}"); state.json NOT saved, will retry next run.`);
    }
  } else if (changeTitle) {
    log(`Release status: CHANGED (${changeTitle})`);
    const ok = await sendNotification(changeMessage(text, changeTitle), 0, {
      title: `TOLC Watch — ${changeTitle}`,
      url: URL,
    });
    if (ok || !providerConfigured) {
      log(ok ? 'Notification status: SENT' : 'Notification status: SKIPPED (no provider configured)');
      saveState({
        hash,
        hasDates,
        failCount: state ? Number(state.failCount || 0) : 0,
        failAlerted: state ? Boolean(state.failAlerted) : false,
        checkedAt: new Date().toISOString(),
      });
      log(`Calendar change alert handled ("${changeTitle}"); state saved.`);
    } else {
      log('Notification status: FAILED');
      log(`Calendar change alert failed ("${changeTitle}"); state.json NOT saved, will retry next run.`);
    }
  } else {
    log('Release status: NOT RELEASED');
    log('Notification status: SKIPPED');
    saveState({
      hash,
      hasDates,
      failCount: state ? Number(state.failCount || 0) : 0,
      failAlerted: state ? Boolean(state.failAlerted) : false,
      checkedAt: new Date().toISOString(),
    });
    log('No release detected. State saved.');
  }

  log('Monitoring completed');
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
