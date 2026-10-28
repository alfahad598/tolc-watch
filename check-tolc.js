import { load } from 'cheerio';
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { sendNotification } from './notify.js';

const URL = 'https://testcisia.it/calendario.php?tolc=cents&lingua=inglese';
const START_MARKER = 'CALENDARIO ISCRIZIONI APERTE';
const END_MARKER = 'CISIA - Via';
const NO_DATES_MARKER = 'Nessuna data disponibile';
const STATE_FILE = 'state.json';
const MIN_TEXT_LEN = 50;
const MAX_TEXT_PREVIEW = 500;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const ACCEPT_LANGUAGE = 'en-US,en;q=0.9';

const args = process.argv.slice(2);
const isTest = args.includes('--test');
const isForceAlert = args.includes('--force-alert');

function log(...msg) {
  console.log(`[${new Date().toISOString()}]`, ...msg);
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Remove script/style tags, take body text, collapse whitespace.
// If both markers exist, slice the text between them.
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

// Return a human-readable failure reason, or null when the page looks fine.
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

// Persist an incremental failure. Exit code 1. Used by normal runs only
// (--test / --force-alert must not touch state.json).
async function recordFailure(reason) {
  log('ERROR:', reason);
  const prev = loadState() || {};
  const failCount = Number(prev.failCount || 0) + 1;
  let failAlerted = Boolean(prev.failAlerted);

  if (failCount >= 6 && !failAlerted) {
    log('Consecutive failures reached 6; sending one failure alert.');
    try {
      await sendNotification(`Watcher is failing: ${reason}`, 0, {
        title: 'Watcher is failing',
        url: URL,
      });
    } catch (err) {
      log('Failure alert send threw:', err.message);
    }
    failAlerted = true; // send ONE failure alert, do not retry it every run
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
  // ---- flags that never touch state.json ----
  if (isTest) {
    const ok = await sendNotification(
      'TOLC Watch test notification — this is only a test.',
      0,
      { title: 'TOLC Watch test', url: URL },
    );
    console.log(`--test: ${ok ? 'at least one provider succeeded' : 'no provider succeeded/configured'}`);
    process.exit(ok ? 0 : 1);
  }

  // ---- fetch the page ----
  let status;
  let html;
  try {
    const res = await fetch(URL, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': ACCEPT_LANGUAGE,
      },
    });
    status = res.status;
    html = await res.text();
  } catch (err) {
    if (isForceAlert) {
      console.error('ERROR: fetch failed:', err.message);
      process.exit(1);
    }
    await recordFailure(`network error: ${err.message}`);
    return;
  }

  const reason = blockPageReason(status, html);
  if (reason) {
    if (isForceAlert) {
      console.error('ERROR:', reason);
      process.exit(1);
    }
    await recordFailure(reason);
    return;
  }

  // ---- extract ----
  const text = extractText(html);
  if (!text || text.length < MIN_TEXT_LEN) {
    if (isForceAlert) {
      console.error(`ERROR: extraction empty or too short (${text ? text.length : 0} chars)`);
      process.exit(1);
    }
    await recordFailure(`extraction empty or too short (${text ? text.length : 0} chars)`);
    return;
  }

  const hash = sha256(text);
  const hasDates = !text.includes(NO_DATES_MARKER);

  // ---- --force-alert: send one real priority 2 alert, no state changes ----
  if (isForceAlert) {
    const ok = await sendNotification(messageFromText(text), 2, {
      title: 'TOLC Watch — forced alert',
      url: URL,
    });
    console.log(`--force-alert: ${ok ? 'alert sent' : 'alert failed (no provider succeeded)'}`);
    process.exit(ok ? 0 : 1);
  }

  // ---- normal run ----
  const state = loadState();
  let alertNeeded = false;
  let title = '';

  if (!state) {
    // First run: alert only if dates are already available.
    if (hasDates) {
      alertNeeded = true;
      title = 'DATES RELEASED';
    }
  } else if (hash !== state.hash) {
    alertNeeded = true;
    if (!state.hasDates && hasDates) {
      title = 'DATES RELEASED';
    } else if (state.hasDates && !hasDates) {
      title = 'Dates removed';
    } else {
      title = 'Calendar changed';
    }
  }

  if (alertNeeded) {
    const priority = title === 'DATES RELEASED' ? 2 : 0;
    const ok = await sendNotification(messageFromText(text), priority, { title, url: URL });
    if (ok) {
      // Save state only after at least one notifier succeeded.
      saveState({ hash, hasDates, failCount: 0, failAlerted: false, checkedAt: new Date().toISOString() });
      log(`Alert sent ("${title}") and state saved.`);
    } else {
      // Do not save state: the alert is retried on the next run.
      log(`Alert failed ("${title}"); state.json NOT saved, will retry next run.`);
    }
  } else {
    // No alert needed: just update checkedAt, keep hash/hasDates/fail counters.
    saveState({
      hash,
      hasDates,
      failCount: state ? Number(state.failCount || 0) : 0,
      failAlerted: state ? Boolean(state.failAlerted) : false,
      checkedAt: new Date().toISOString(),
    });
    log('No alert needed. checkedAt updated.');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
