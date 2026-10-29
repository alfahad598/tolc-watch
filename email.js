// Gmail SMTP email notifier for TOLC Watch.
//
// Environment variables (server-side only):
//   SMTP_USER          - Gmail address used to authenticate (also the From address).
//   SMTP_PASSWORD      - Gmail App Password (NOT the normal account password).
//   EMAIL_RECIPIENTS   - Comma-separated recipient addresses (sent via BCC).
//   EMAIL_TRANSPORT    - Optional. Set to 'stream' to capture messages locally/tests.
//
// Delivery state is persisted in email-queue.json so a failed email is retried on
// the next run without resending emails that already succeeded. The queue never
// stores recipient addresses: they are read from EMAIL_RECIPIENTS at send time.
//
// Credentials are never logged. SMTP password is redacted from error messages.

import { createHash } from 'crypto';
import {
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import nodemailer from 'nodemailer';

const SMTP_HOST = 'smtp.gmail.com';
const SMTP_PORT = 465;
const MAX_SEND_ATTEMPTS = 3;
const MAX_QUEUE_ENTRIES = 200;
const LOCK_STALE_MS = 10 * 60 * 1000;
const EMAIL_REGEX = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

function queueFile() {
  return process.env.EMAIL_QUEUE_FILE || 'email-queue.json';
}

function lockFile() {
  return process.env.EMAIL_LOCK_FILE || 'email-queue.lock';
}

function log(...msg) {
  console.log(`[${new Date().toISOString()}] [Email]`, ...msg);
}

function now() {
  return new Date().toISOString();
}

// ---------- Configuration ----------

function getSmtpUser() {
  return process.env.SMTP_USER || '';
}

function getSmtpPassword() {
  return process.env.SMTP_PASSWORD || '';
}

// Gmail App Passwords are often displayed as "abcd efgh ijkl mnop"; the SMTP
// server expects the 16 characters without spaces.
function smtpAuthPassword() {
  return getSmtpPassword().replace(/\s+/g, '');
}

export function isValidEmail(address) {
  return EMAIL_REGEX.test(address);
}

export function getEmailRecipients() {
  const raw = process.env.EMAIL_RECIPIENTS || '';
  const seen = new Set();
  const recipients = [];
  for (const part of raw.split(',')) {
    const address = part.trim();
    if (!address || !EMAIL_REGEX.test(address)) continue;
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push(address);
  }
  return recipients;
}

export function emailEnabled() {
  return Boolean(
    getSmtpUser() && getSmtpPassword() && getEmailRecipients().length > 0,
  );
}

// ---------- Transporter ----------

let transporter = null;

// Allows tests (or advanced setups) to inject a custom nodemailer transport.
export function setEmailTransporter(customTransporter) {
  transporter = customTransporter || null;
}

function getTransporter() {
  if (transporter) return transporter;
  if (process.env.EMAIL_TRANSPORT === 'stream') {
    transporter = nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
      newline: 'unix',
    });
    return transporter;
  }
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: true,
    auth: {
      user: getSmtpUser(),
      pass: smtpAuthPassword(),
    },
    // Keep a stuck SMTP connection from delaying the whole monitoring run.
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
  return transporter;
}

function safeError(err) {
  let message = err && err.message ? err.message : String(err);
  for (const secret of new Set([getSmtpPassword(), smtpAuthPassword()])) {
    if (secret) message = message.split(secret).join('[redacted]');
  }
  return message;
}

// ---------- Content ----------

function formatDhaka(date = new Date()) {
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

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildEmailContent({
  title = 'Website update detected',
  message = '',
  url = '',
  detectedAt = new Date(),
  websiteName = process.env.WEBSITE_NAME || 'TOLC CEnT-S (testcisia.it)',
} = {}) {
  const when = formatDhaka(detectedAt instanceof Date ? detectedAt : new Date(detectedAt));
  const safeTitle = escapeHtml(title);
  const safeWebsite = escapeHtml(websiteName);
  const safeWhen = escapeHtml(when);
  const safeMessage = escapeHtml(message || '(no details provided)').replace(/\n/g, '<br>');
  const safeUrl = escapeHtml(url);
  const subject = `[TOLC Watch] ${title}`;

  const text = [
    'WEBSITE MONITORING ALERT',
    '',
    `Website: ${websiteName}`,
    `Detected: ${when} (Asia/Dhaka)`,
    `Update: ${title}`,
    '',
    message || '(no details provided)',
    '',
    url ? `View the update: ${url}` : '',
    '',
    '--',
    'Automated Website Monitoring System',
  ]
    .filter((line, index, all) => line !== '' || all[index - 1] !== '')
    .join('\n');

  const buttonHtml = url
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 0;"><tr><td style="border-radius:8px;background:#2563eb;">
            <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:13px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">View Website Update</a>
          </td></tr></table>
          <p style="margin:18px 0 0;font-size:12px;line-height:1.6;color:#94a3b8;word-break:break-all;">${safeUrl}</p>`
    : '';

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6f8;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
          <tr>
            <td style="background:#0f172a;padding:24px 28px;">
              <div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#93c5fd;font-weight:600;">Website Monitoring Alert</div>
              <div style="font-size:22px;line-height:1.3;color:#ffffff;font-weight:700;margin-top:6px;">${safeTitle}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:28px;">
              <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#334155;">A change was detected on the monitored website.</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;color:#334155;">
                <tr>
                  <td style="padding:8px 0;width:140px;color:#64748b;">Website</td>
                  <td style="padding:8px 0;font-weight:600;">${safeWebsite}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#64748b;">Detected</td>
                  <td style="padding:8px 0;font-weight:600;">${safeWhen} (Asia/Dhaka)</td>
                </tr>
              </table>
              <div style="margin:20px 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:0.6px;color:#64748b;font-weight:600;">Update details</div>
              <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;font-size:14px;line-height:1.6;color:#1e293b;word-break:break-word;">${safeMessage}</div>
              ${buttonHtml}
            </td>
          </tr>
          <tr>
            <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:18px 28px;text-align:center;font-size:12px;color:#94a3b8;">Automated Website Monitoring System</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}

// ---------- Queue persistence ----------

function loadQueue() {
  try {
    if (!existsSync(queueFile())) return { entries: [] };
    const data = JSON.parse(readFileSync(queueFile(), 'utf8'));
    if (!data || !Array.isArray(data.entries)) return { entries: [] };
    return data;
  } catch (err) {
    log('Warning: could not read email queue, starting fresh:', safeError(err));
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
      lockFile(),
      JSON.stringify({ pid: process.pid, startedAt: now() }),
      { flag: 'wx' },
    );
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') return false;
    try {
      const mtime = statSync(lockFile()).mtimeMs;
      if (Date.now() - mtime > LOCK_STALE_MS) {
        try {
          unlinkSync(lockFile());
        } catch (_) {
          return false;
        }
        try {
          writeFileSync(
            lockFile(),
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
    unlinkSync(lockFile());
  } catch (_) {
    // Already removed.
  }
}

// ---------- Delivery ----------

async function deliver(entry) {
  const acquired = acquireLock();
  if (!acquired) {
    log('Another worker is sending email; skipping this run.');
    return false;
  }

  try {
    const recipients = getEmailRecipients();
    if (recipients.length === 0) {
      log('No valid EMAIL_RECIPIENTS configured; skipping email.');
      return false;
    }

    const { subject, text, html } = buildEmailContent({
      title: entry.title,
      message: entry.message,
      url: entry.url,
      detectedAt: entry.detectedAt,
    });

    entry.attempts = Number(entry.attempts || 0) + 1;
    entry.updatedAt = now();

    try {
      const info = await getTransporter().sendMail({
        from: `"TOLC Watch" <${getSmtpUser()}>`,
        // Send to ourselves and put every recipient in BCC so they cannot see
        // each other's addresses.
        to: getSmtpUser(),
        bcc: recipients.join(', '),
        subject,
        text,
        html,
      });
      entry.status = 'sent';
      entry.sentAt = now();
      entry.lastError = null;
      log(
        `Delivered to ${recipients.length} recipient(s) via BCC (messageId: ${
          (info && info.messageId) || 'n/a'
        }).`,
      );
      return true;
    } catch (err) {
      entry.status = 'failed';
      entry.lastError = safeError(err);
      log(`Delivery failed (attempt ${entry.attempts}/${MAX_SEND_ATTEMPTS}): ${entry.lastError}`);
      return false;
    }
  } finally {
    releaseLock();
  }
}

// ---------- Public API ----------

/**
 * Send an email for a detected update. Deduplicated by title/message/url so the
 * same update is never emailed twice. Returns true when the email was sent (or
 * had already been sent). Never throws.
 */
export async function sendEmail(options = {}) {
  const { title = 'TOLC Watch', message = '', url = '', force = false } = options;

  if (!emailEnabled()) {
    log('Email not configured (SMTP_USER / SMTP_PASSWORD / EMAIL_RECIPIENTS); skipping.');
    return false;
  }

  try {
    const dedupeKey = createHash('sha256')
      .update(`${title}\0${message}\0${url}`, 'utf8')
      .digest('hex');

    const queue = loadQueue();
    let entry = queue.entries.find((e) => e.dedupeKey === dedupeKey);

    if (entry && entry.status === 'sent' && !force) {
      log('Email for this update was already delivered; duplicate suppressed.');
      return true;
    }

    if (!entry) {
      entry = {
        id: createHash('sha256')
          .update(`${dedupeKey}\0${now()}\0${Math.random()}`, 'utf8')
          .digest('hex')
          .slice(0, 16),
        dedupeKey,
        title,
        message,
        url,
        detectedAt: now(),
        createdAt: now(),
        updatedAt: now(),
        status: 'pending',
        attempts: 0,
        lastError: null,
      };
      queue.entries.push(entry);
    } else if (force) {
      entry.status = 'pending';
      entry.attempts = 0;
      entry.lastError = null;
      entry.updatedAt = now();
    } else if (entry.status === 'failed' && entry.attempts >= MAX_SEND_ATTEMPTS) {
      log('Email delivery previously failed permanently; not retrying.');
      return false;
    } else {
      entry.status = 'pending';
      entry.updatedAt = now();
    }

    saveQueue(queue);
    const ok = await deliver(entry);
    entry.updatedAt = now();
    saveQueue(queue);
    return ok;
  } catch (err) {
    log('Email send threw unexpectedly:', safeError(err));
    return false;
  }
}

/**
 * Retry queued emails that have not been delivered yet. Safe to run at the start
 * of every monitoring run; already-delivered emails are skipped.
 */
export async function processEmailQueue() {
  if (!emailEnabled()) return;

  try {
    const queue = loadQueue();
    const retries = queue.entries.filter(
      (e) =>
        e.status === 'pending' ||
        (e.status === 'failed' && Number(e.attempts || 0) < MAX_SEND_ATTEMPTS),
    );
    if (retries.length === 0) return;

    log(`Found ${retries.length} queued email(s) to retry.`);
    for (const entry of retries) {
      const ok = await deliver(entry);
      entry.updatedAt = now();
      if (ok) log('Queued email delivered.');
    }
    saveQueue(queue);
  } catch (err) {
    log('Email queue processing threw:', safeError(err));
  }
}

/**
 * Send a test email through the same SMTP configuration used in production.
 * Returns true only when the SMTP server accepted the message.
 */
export async function sendTestEmail() {
  if (!emailEnabled()) {
    log('Email test skipped: SMTP_USER / SMTP_PASSWORD / EMAIL_RECIPIENTS not fully configured.');
    return false;
  }

  const recipients = getEmailRecipients();
  // Send directly (no queue entry) so a failed test email is never retried by a
  // later scheduled run.
  const ok = await deliver({
    title: 'Test email',
    message:
      'This is a test email from the TOLC Watch monitoring system. If you received it, Gmail SMTP is configured correctly.',
    url: process.env.WEBSITE_URL || 'https://testcisia.it/calendario.php?tolc=cents&lingua=inglese',
    detectedAt: now(),
    attempts: 0,
  });

  log(ok ? `Test email sent to ${recipients.length} recipient(s).` : 'Test email failed.');
  return ok;
}
