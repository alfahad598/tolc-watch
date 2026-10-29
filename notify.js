// Telegram Bot: POST https://api.telegram.org/bot<TOKEN>/sendMessage
// Success = HTTP 200 and JSON ok === true. Sent to every allowed chat ID
// individually; one recipient's failure never blocks another.
import { sendTelegram, telegramEnabled as telegramConfigured } from './telegram.js';
import { sendEmail, emailEnabled as emailConfigured } from './email.js';

export function telegramEnabled() {
  return telegramConfigured();
}

// Gmail SMTP: nodemailer over smtp.gmail.com:465 (see email.js).
export function emailEnabled() {
  return emailConfigured();
}

// Pushover: POST https://api.pushover.net/1/messages.json
// Success = HTTP 200 and JSON status === 1.
export function pushoverEnabled() {
  return Boolean(process.env.PUSHOVER_TOKEN && process.env.PUSHOVER_USER);
}

export async function sendPushover({ title, message, url, priority = 0 }) {
  const body = new URLSearchParams();
  body.set('token', process.env.PUSHOVER_TOKEN);
  body.set('user', process.env.PUSHOVER_USER);
  body.set('title', title);
  body.set('message', message);
  body.set('url', url || '');
  body.set('url_title', 'TOLC Watch');
  body.set('priority', String(priority));
  // Date alerts use priority 2: repeat every 60s for up to 3600s until acknowledged.
  if (priority === 2) {
    body.set('retry', '60');
    body.set('expire', '3600');
  }

  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  let json = {};
  try {
    json = await res.json();
  } catch (_) {
    // ignore parse errors
  }
  const ok = res.status === 200 && json.status === 1;
  if (ok) {
    console.log(`[Pushover] OK (HTTP ${res.status}, priority ${priority})`);
  } else {
    const errors = json.errors ? ` ${JSON.stringify(json.errors)}` : '';
    console.log(`[Pushover] FAILED (HTTP ${res.status})${errors}`);
  }
  return ok;
}

// CallMeBot WhatsApp: GET https://api.callmebot.com/whatsapp.php?phone=&text=&apikey=
// Success = HTTP 200. Keep text under 900 chars.
export function callmebotEnabled() {
  return Boolean(process.env.CALLMEBOT_PHONE && process.env.CALLMEBOT_APIKEY);
}

export async function sendCallmebot({ text }) {
  const params = new URLSearchParams({
    phone: process.env.CALLMEBOT_PHONE,
    text: text.slice(0, 900),
    apikey: process.env.CALLMEBOT_APIKEY,
  });
  const res = await fetch(`https://api.callmebot.com/whatsapp.php?${params.toString()}`);
  let bodyText = '';
  try {
    bodyText = await res.text();
  } catch (_) {
    // ignore
  }
  const ok = res.status === 200;
  if (ok) {
    console.log(`[CallMeBot] OK (HTTP ${res.status})`);
  } else {
    console.log(`[CallMeBot] FAILED (HTTP ${res.status})${bodyText ? ` ${bodyText.slice(0, 200)}` : ''}`);
  }
  return ok;
}

// True when at least one notifier has the credentials it needs.
export function hasNotificationProvider() {
  return pushoverEnabled() || callmebotEnabled() || telegramEnabled() || emailEnabled();
}

// Send to all enabled providers in parallel. Returns true if at least one succeeded.
export async function sendNotification(text, priority, options = {}) {
  const { title = 'TOLC Watch', url, force = false } = options;
  const calls = [];
  if (pushoverEnabled()) {
    calls.push(sendPushover({ title, message: text, url, priority }));
  }
  if (callmebotEnabled()) {
    calls.push(sendCallmebot({ text }));
  }
  if (telegramEnabled()) {
    calls.push(sendTelegram({ title, message: text, url, priority, force }));
  }
  if (emailEnabled()) {
    calls.push(sendEmail({ title, message: text, url, force }));
  }

  if (calls.length === 0) {
    console.error(
      '[notify] No notification provider configured. Set PUSHOVER_TOKEN/PUSHOVER_USER and/or CALLMEBOT_PHONE/CALLMEBOT_APIKEY and/or TELEGRAM_BOT_TOKEN/TELEGRAM_ALLOWED_CHAT_IDS and/or SMTP_USER/SMTP_PASSWORD/EMAIL_RECIPIENTS.',
    );
    return false;
  }

  const results = await Promise.allSettled(calls);
  let anyOk = false;
  for (const result of results) {
    if (result.status === 'fulfilled') {
      if (result.value) anyOk = true;
    } else {
      console.error('[notify] Provider threw:', result.reason);
    }
  }
  return anyOk;
}
