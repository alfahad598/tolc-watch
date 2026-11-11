import dotenv from 'dotenv';
dotenv.config();

import { load } from 'cheerio';
import {
  parseSessions,
  toStoredSessions,
  diffSessions,
  hasNotifiableChange,
  eventId,
  sessionKey,
  isAvailable,
} from './calendar-events.js';
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
const FETCH_TIMEOUT_MS = 30000;
const HEARTBEAT_MS = 60 * 60 * 1000;
const FAIL_ALERT_THRESHOLD = 5;

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

function sessionLine(s, current) {
  const live = current?.find((c) => sessionKey(c) === sessionKey(s)) || s;
  const seats = live.seats && live.seats !== '---' ? `${live.seats} ` : '';
  return `📅 ${s.testDate} — ${s.university} (${s.city}), ${s.mode} — register by ${s.deadline} — ${seats}${live.status || ''}`.trim();
}

function changeMessage(diff, current = []) {
  const sections = [];
  if (diff.added.length) {
    sections.push(`🚨 NEW EXAM DATE(S) RELEASED (${diff.added.length})\n${diff.added.map((s) => sessionLine(s, current)).join('\n')}`);
  }
  if (diff.reopened.length) {
    sections.push(`🟢 SEATS AVAILABLE AGAIN\n${diff.reopened.map((s) => sessionLine(s, current)).join('\n')}`);
  }
  if (diff.deadlineChanged.length) {
    sections.push(`🕒 REGISTRATION DEADLINE CHANGED\n${diff.deadlineChanged.map((s) => `${sessionLine(s, current)} (was ${s.oldDeadline})`).join('\n')}`);
  }
  if (diff.removedEarly.length) {
    sections.push(`❌ SESSION REMOVED BEFORE DEADLINE\n${diff.removedEarly.map((s) => sessionLine(s)).join('\n')}`);
  }
  return `${sections.join('\n\n')}

🔗 Book: ${URL}
🕒 Detected: ${dhakaTime()}`;
}

function testMessage() {
  return `✅ TOLC WATCH IS ACTIVE!

🔍 Website monitoring initialized.
⏱️ Checking interval: about every 2 minutes.
📡 GitHub Actions: Working.
🔔 Notifications: Connected.

🕒 Test Time: ${dhakaTime()}`;
}

function statusMessage(sessions, status) {
  const open = sessions.filter(isAvailable).length;
  return `✅ TOLC WATCH — LIVE CHECK

🌐 Website: ${URL}
📖 Status: Website is readable (HTTP ${status})
📅 Sessions listed: ${sessions.length} (${open} with seats available)
🕒 Checked: ${dhakaTime()}`;
}

async function recordFailure(reason) {
  log('ERROR:', reason);
  const prev = loadState() || {};
  const failCount = Number(prev.failCount || 0) + 1;
  let failAlerted = Boolean(prev.failAlerted);

  if (failCount >= FAIL_ALERT_THRESHOLD && !failAlerted) {
    log('Consecutive failures reached threshold; sending one failure alert.');
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
    ...prev,
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

  const sessions = parseSessions(html);
  const noDatesShown = text.includes(NO_DATES_MARKER);
  if (sessions === null && !noDatesShown) {
    log('Release detection completed: CALENDAR TABLE NOT FOUND (page layout may have changed)');
    await recordFailure('calendar table not found and no "no dates" notice; page layout may have changed');
    return;
  }
  const currentSessions = sessions || [];
  const hasDates = currentSessions.length > 0;
  const hash = sha256(JSON.stringify(toStoredSessions(currentSessions)));
  log(`Release detection completed: ${currentSessions.length} session(s) listed`);

  if (isDryRun) {
    log(`--dry-run: HTTP ${status}, ${text.length} chars, hash ${hash.slice(0, 12)}…, hasDates=${hasDates}`);
    for (const s of currentSessions) log(`--dry-run: ${sessionLine(s)}`);
    process.exit(0);
  }

  // ---- Send live status message (confirms website is readable) ----
  if (isStatusAlert) {
    log('Sending live status notification...');
    const ok = await sendNotification(statusMessage(currentSessions, status), 0, {
      title: 'TOLC WATCH — Live Check',
      url: URL,
    });
    console.log(`--status-alert: ${ok ? 'status notification sent' : 'status notification failed (no provider succeeded)'}`);
    if (!ok) process.exit(1);
  }

  // ---- --force-alert: send one real priority 2 alert, no state changes ----
  if (isForceAlert) {
    const ok = await sendNotification(
      changeMessage({ added: currentSessions, reopened: [], deadlineChanged: [], removedEarly: [] }),
      2,
      { title: 'TOLC Watch — forced alert', url: URL, force: true },
    );
    console.log(`--force-alert: ${ok ? 'alert sent' : 'alert failed (no provider succeeded)'}`);
    process.exit(ok ? 0 : 1);
  }

  // ---- compare with previous state ----
  const state = loadState() || {};
  // Migration from the old whole-page-hash state: if dates were already being
  // shown, adopt the current sessions as the baseline instead of re-alerting.
  const previousSessions = state.sessions ?? (state.hasDates ? toStoredSessions(currentSessions) : {});
  const diff = diffSessions(previousSessions, currentSessions);
  const notify = hasNotifiableChange(diff);
  let revision = Number(state.revision || 0);

  for (const s of diff.soldOut) log(`Sold out (silent): ${sessionLine(s)}`);
  for (const s of diff.removedExpired) log(`Registration closed and removed (silent): ${sessionLine(s)}`);

  const nextState = () => {
    const changed = state.hash !== hash || state.revision !== revision || state.failCount;
    const last = Date.parse(state.checkedAt || 0) || 0;
    // Only refresh the heartbeat hourly so the looping workflow doesn't commit every check.
    const checkedAt =
      changed || Date.now() - last > HEARTBEAT_MS ? new Date().toISOString() : state.checkedAt;
    return { revision, hash, hasDates, sessions: diff.current, failCount: 0, failAlerted: false, checkedAt };
  };

  if (notify) {
    revision += 1;
    const priority = diff.added.length ? 2 : diff.reopened.length ? 1 : 0;
    const title = diff.added.length
      ? 'TOLC Watch — NEW exam date released'
      : diff.reopened.length
        ? 'TOLC Watch — Seats available again'
        : 'TOLC Watch — Schedule changed';
    log(`Release status: CHANGED (${title}) — added ${diff.added.length}, reopened ${diff.reopened.length}, deadline ${diff.deadlineChanged.length}, removed ${diff.removedEarly.length}`);
    const ok = await sendNotification(changeMessage(diff, currentSessions), priority, {
      title,
      url: URL,
      eventId: eventId(revision, diff),
    });
    if (ok || !hasNotificationProvider()) {
      log(ok ? 'Notification status: SENT' : 'Notification status: SKIPPED (no provider configured)');
      saveState(nextState());
    } else {
      log('Notification status: FAILED; state.json NOT saved, will retry next run.');
    }
  } else {
    log(hasDates ? 'Release status: NO NEW SESSIONS' : 'Release status: NOT RELEASED');
    log('Notification status: SKIPPED');
    saveState(nextState());
  }

  log('Monitoring completed');
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
