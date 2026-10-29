// Telegram Bot API notifier for TOLC Watch.
// Official API: https://core.telegram.org/bots/api#sendmessage
//
// Environment variables (server-side only):
//   TELEGRAM_BOT_TOKEN            - Bot token from @BotFather. NEVER logged, NEVER sent to a frontend.
//   TELEGRAM_ALLOWED_CHAT_IDS     - Comma-separated allowlist of recipient chat IDs.
//   TELEGRAM_NOTIFICATIONS_ENABLED - 'true' (default) or 'false'.
//
// Persistence (no new infrastructure):
//   telegram-queue.json  - pending/sent/failed deliveries, survives restarts
//   telegram-queue.lock  - short-lived lock so concurrent workers don't double-send
//
// Design notes:
//   * Messages are sent without `parse_mode`, so Telegram renders them as plain
//     text and HTML/Markdown injection from page content is impossible.
//   * Each recipient is sent to individually; one recipient's failure never
//     blocks another recipient.
//   * HTTP 429 (rate limit) is honoured via `retry_after`; other transient
//     failures use exponential backoff.
//   * Credentials are never logged.

import { createHash } from 'crypto';
import {
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';

function queueFile() {
  return process.env.TELEGRAM_QUEUE_FILE || 'telegram-queue.json';
}
const LOCK_FILE = 'telegram-queue.lock';
const API_BASE = 'https://api.telegram.org';
const MAX_SEND_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const LOCK_STALE_MS = 10 * 60 * 1000;
const MAX_QUEUE_ENTRIES = 200;
// Used by tests to skip real sleeps.
function fastMode() {
  return process.env.TELEGRAM_TEST_FAST === '1';
}

const TOKEN_REGEX = /^\d+:[A-Za-z0-9_-]{10,}$/;
const CHAT_ID_REGEX = /^-?\d+$/;

function log(...msg) {
  console.log(`[${new Date().toISOString()}] [Telegram]`, ...msg);
}

function now() {
  return new Date().toISOString();
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt) {
  if (fastMode()) return 20;
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

// ---------- Configuration ----------

function getBotToken() {
  return process.env.TELEGRAM_BOT_TOKEN || '';
}

export function isValidBotToken(token) {
  return TOKEN_REGEX.test(token);
}

export function getAllowedChatIds() {
  const raw = process.env.TELEGRAM_ALLOWED_CHAT_IDS || '';
  const seen = new Set();
  const ids = [];
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (!id || !CHAT_ID_REGEX.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function telegramNotificationsEnabled() {
  return process.env.TELEGRAM_NOTIFICATIONS_ENABLED !== 'false';
}

export function telegramEnabled() {
  const token = getBotToken();
  return Boolean(
    token &&
      isValidBotToken(token) &&
      telegramNotificationsEnabled() &&
      getAllowedChatIds().length > 0,
  );
}

// ---------- Queue persistence ----------

function loadQueue() {
  try {
    if (!existsSync(queueFile())) return { entries: [] };
    const data = JSON.parse(readFileSync(queueFile(), 'utf8'));
    if (!data || !Array.isArray(data.entries)) return { entries: [] };
    return data;
  } catch (err) {
    log('Warning: could not read notification queue, starting fresh:', err.message);
    return { entries: [] };
  }
}

function saveQueue(queue) {
  const entries = (queue.entries || []).slice(-MAX_QUEUE_ENTRIES);
  writeFileSync(queueFile(), JSON.stringify({ entries }, null, 2));
}

// ---------- Concurrency lock ----------

function acquireLock() {
  try {
    writeFileSync(
      LOCK_FILE,
      JSON.stringify({ pid: process.pid, startedAt: now() }),
      { flag: 'wx' },
    );
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') return false;
    try {
      const mtime = statSync(LOCK_FILE).mtimeMs;
      if (Date.now() - mtime > LOCK_STALE_MS) {
        try {
          unlinkSync(LOCK_FILE);
        } catch (_) {
          return false;
        }
        try {
          writeFileSync(
            LOCK_FILE,
            JSON.stringify({ pid: process.pid, startedAt: now() }),
            { flag: 'wx' },
          );
          return true;
        } catch (_) {
          return false;
        }
      }
    } catch (_) {
      return false;
    }
    return false;
  }
}

function releaseLock() {
  try {
    unlinkSync(LOCK_FILE);
  } catch (_) {
    // Already removed.
  }
}

// ---------- Telegram API ----------

async function sendMessage(chatId, text) {
  const token = getBotToken();
  // Token is embedded in the request URL but never logged.
  const url = `${API_BASE}/bot${encodeURIComponent(token)}/sendMessage`;
  const body = JSON.stringify({
    chat_id: chatId,
    text,
    // Plain text only: no parse_mode, so no HTML/Markdown injection is possible.
    disable_web_page_preview: true,
  });

  let lastError = 'unknown error';
  let lastCode;

  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    } catch (err) {
      lastError = err.message;
      await sleep(backoffMs(attempt));
      continue;
    }

    let json = {};
    try {
      json = await res.json();
    } catch (_) {
      // Ignore parse errors; fall through to status-based handling.
    }

    if (res.ok && json.ok === true) {
      return { sent: true };
    }

    const code = Number(json.error_code || res.status);
    lastCode = code;
    lastError = json.description || `HTTP ${res.status}`;
    log(`Request attempt ${attempt} failed: ${lastError}`);

    // Honour Telegram rate limits.
    if (code === 429) {
      const retryAfter = Number(json.parameters?.retry_after) || 0;
      await sleep(
        fastMode() ? 20 : Math.min(Math.max(retryAfter, 1) * 1000, MAX_BACKOFF_MS),
      );
      continue;
    }

    // Client errors (400/401/403/404, e.g. invalid token or chat ID) are
    // permanent for this recipient — do not retry.
    if (code >= 400 && code < 500) {
      return { sent: false, error: lastError, code };
    }

    // Server errors / network blips: retry with exponential backoff.
    await sleep(backoffMs(attempt));
  }

  return { sent: false, error: lastError, code: lastCode };
}

// ---------- Message formatting ----------

function formatAsiaDhaka(date = new Date()) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

function buildTelegramMessage({ title = 'TOLC Watch', message = '', url = '' }) {
  const detected = formatAsiaDhaka();
  const lines = [
    '🚨 NEW RELEASE DETECTED!',
    '',
    `🌐 Website: ${title}`,
    `📢 Release: ${message.trim() || '(no title)'}`,
    `🕒 Detected: ${detected} (Asia/Dhaka)`,
  ];
  if (url) {
    lines.push('', `🔗 View Release:\n${url}`);
  }
  return lines.join('\n');
}

function makeDedupeKey({ title, message, url }) {
  return createHash('sha256')
    .update(`${title || ''}\0${message || ''}\0${url || ''}`, 'utf8')
    .digest('hex');
}

async function deliverEntry(entry, text, queue) {
  const acquired = acquireLock();
  if (!acquired) {
    log('Another worker is processing the Telegram queue; skipping this run.');
    return {
      anySent: entry.recipients.some((r) => r.status === 'sent'),
      results: entry.recipients.map((r) => ({ chatId: r.chatId, status: r.status })),
    };
  }

  try {
    let anySent = false;
    const results = [];

    for (let i = 0; i < entry.recipients.length; i++) {
      const recipient = entry.recipients[i];
      if (recipient.status === 'sent') {
        anySent = true;
        results.push({ chatId: recipient.chatId, status: 'sent' });
        continue;
      }

      const outcome = await sendMessage(recipient.chatId, text);
      recipient.attempts += 1;
      recipient.updatedAt = now();

      if (outcome.sent) {
        recipient.status = 'sent';
        recipient.sentAt = now();
        recipient.lastError = null;
        anySent = true;
        log(`Delivered to recipient ${i + 1}/${entry.recipients.length}.`);
      } else {
        recipient.status = 'failed';
        recipient.lastError = outcome.error;
        // Client errors (bad chat ID, unauthorized bot) are permanent for this
        // recipient and must not be retried on every run.
        recipient.permanent = Boolean(outcome.code) && outcome.code >= 400 && outcome.code < 500 && outcome.code !== 429;
        log(
          `Failed to deliver to recipient ${i + 1}/${entry.recipients.length}: ${outcome.error}`,
        );
      }
      entry.updatedAt = now();
      results.push({ chatId: recipient.chatId, status: recipient.status, error: recipient.lastError });
      // Persist after every recipient so a crash never loses delivery results.
      saveQueue(queue);
    }

    return { anySent, results };
  } finally {
    releaseLock();
  }
}

// ---------- Public API ----------

/**
 * Send a Telegram notification to every allowed recipient.
 * Options: { title, message, url, priority, force }
 *   force - resend even if this release was already delivered (used by --test/--force-alert)
 * Returns true if at least one recipient received the message (or it was already delivered).
 */
export async function sendTelegram(options = {}) {
  const { title = 'TOLC Watch', message = '', url = '', force = false } = options;

  if (!telegramNotificationsEnabled()) {
    log('Telegram notifications are disabled (TELEGRAM_NOTIFICATIONS_ENABLED=false).');
    return false;
  }

  const token = getBotToken();
  if (!token) {
    log('Telegram not configured: TELEGRAM_BOT_TOKEN is missing.');
    return false;
  }
  if (!isValidBotToken(token)) {
    log('Telegram not configured: TELEGRAM_BOT_TOKEN has an invalid format.');
    return false;
  }

  const chatIds = getAllowedChatIds();
  if (chatIds.length === 0) {
    log('Telegram not configured: no valid chat IDs in TELEGRAM_ALLOWED_CHAT_IDS.');
    return false;
  }

  const text = buildTelegramMessage({ title, message, url });
  const dedupeKey = makeDedupeKey({ title, message, url });

  const queue = loadQueue();
  let entry = queue.entries.find((e) => e.dedupeKey === dedupeKey);

  const alreadyDelivered = Boolean(entry) && entry.recipients.some((r) => r.status === 'sent');
  if (alreadyDelivered && !force) {
    log(
      `Release already delivered to Telegram recipients; duplicate suppressed (${chatIds.length} recipient(s)).`,
    );
    return true;
  }

  if (!entry) {
    entry = {
      id: createHash('sha256')
        .update(`${dedupeKey}\0${now()}\0${Math.random()}`, 'utf8')
        .digest('hex')
        .slice(0, 16),
      dedupeKey,
      title: title || '',
      message: message || '',
      url: url || '',
      createdAt: now(),
      updatedAt: now(),
      recipients: chatIds.map((chatId) => ({ chatId, status: 'pending', attempts: 0 })),
    };
    queue.entries.push(entry);
  } else {
    // Retry an earlier incomplete delivery on a subsequent run. With force,
    // reset every recipient so an already-delivered message is sent again.
    for (const recipient of entry.recipients) {
      if (force || (recipient.status !== 'sent' && !recipient.permanent)) {
        recipient.status = 'pending';
        recipient.attempts = 0;
        recipient.lastError = null;
        delete recipient.permanent;
        delete recipient.sentAt;
      }
    }
    entry.updatedAt = now();
  }

  saveQueue(queue);

  const result = await deliverEntry(entry, text, queue);
  saveQueue(queue);
  return result.anySent;
}

/**
 * Retry pending queue entries. Safe to run at the start of every check run;
 * recovers notifications that failed before a server restart.
 */
export async function processTelegramQueue() {
  const queue = loadQueue();
  const retries = queue.entries.filter((e) =>
    e.recipients.some(
      (r) =>
        r.status === 'pending' ||
        (r.status === 'failed' && !r.permanent && r.attempts < MAX_SEND_ATTEMPTS),
    ),
  );
  if (retries.length === 0) return;

  log(`Found ${retries.length} queue entry(ies) with pending recipient(s); retrying...`);

  const textOf = (e) =>
    buildTelegramMessage({ title: e.title, message: e.message, url: e.url });

  for (const entry of retries) {
    await deliverEntry(entry, textOf(entry), queue);
  }
  saveQueue(queue);
}

/**
 * Snapshot of Telegram configuration + queue state (for status reporting).
 * No secrets are returned.
 */
export function getTelegramStatus() {
  const queue = loadQueue();
  const entries = queue.entries || [];
  const byStatus = { pending: 0, sent: 0, failed: 0 };
  for (const entry of entries) {
    for (const recipient of entry.recipients) {
      byStatus[recipient.status] = (byStatus[recipient.status] || 0) + 1;
    }
  }
  const last = entries
    .slice()
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
  const token = getBotToken();
  return {
    enabled: telegramEnabled(),
    notificationsEnabled: telegramNotificationsEnabled(),
    tokenConfigured: Boolean(token),
    token: token ? `${token.slice(0, 4)}…${token.slice(-4)}` : '(not set)',
    recipients: getAllowedChatIds().length,
    totalEntries: entries.length,
    byStatus,
    lastEntry: last
      ? {
          id: last.id,
          title: last.title,
          updatedAt: last.updatedAt,
          recipients: last.recipients.map((r) => ({ status: r.status, attempts: r.attempts })),
        }
      : null,
  };
}
