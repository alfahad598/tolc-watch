import assert from 'node:assert';
import fs from 'fs';

// ---- Test environment (read lazily by email.js / telegram.js) ----
process.env.SMTP_USER = 'sender@gmail.com';
process.env.SMTP_PASSWORD = 'super-secret-app-password';
process.env.EMAIL_RECIPIENTS = 'a@example.com, B@Example.com, invalid-id, , a@example.com';
process.env.EMAIL_QUEUE_FILE = './.test-email-queue.json';
process.env.EMAIL_LOCK_FILE = './.test-email-queue.lock';

// Isolate from real Pushover/CallMeBot.
process.env.PUSHOVER_TOKEN = '';
process.env.PUSHOVER_USER = '';
process.env.CALLMEBOT_PHONE = '';
process.env.CALLMEBOT_APIKEY = '';

// Telegram is mocked below so sendNotification integration can be checked.
process.env.TELEGRAM_BOT_TOKEN = '123456789:ABCdefGHIjklMNOpqrsTUVwxyz123456789';
process.env.TELEGRAM_ALLOWED_CHAT_IDS = '123456789';
process.env.TELEGRAM_NOTIFICATIONS_ENABLED = 'true';
process.env.TELEGRAM_QUEUE_FILE = './.test-telegram-queue.json';
process.env.TELEGRAM_TEST_FAST = '1';

const URL = 'https://testcisia.it/calendario.php?tolc=cents&lingua=inglese';
const EMAIL_QUEUE = '.test-email-queue.json';
const EMAIL_LOCK = '.test-email-queue.lock';
const TELEGRAM_QUEUE = '.test-telegram-queue.json';

import {
  buildEmailContent,
  emailEnabled,
  getEmailRecipients,
  isValidEmail,
  processEmailQueue,
  sendEmail,
  sendTestEmail,
  setEmailTransporter,
} from './email.js';
import { sendNotification } from './notify.js';

// ---- Mocked Telegram Bot API (no real network) ----
let telegramCalls = 0;
globalThis.fetch = async () => {
  telegramCalls += 1;
  return {
    status: 200,
    ok: true,
    json: async () => ({ ok: true, result: { message_id: 1 } }),
    text: async () => '{}',
  };
};

// ---- Injected SMTP transporter (no real email) ----
let sent = [];
let failNextSend = null;
setEmailTransporter({
  async sendMail(options) {
    if (failNextSend) throw new Error(failNextSend);
    sent.push(options);
    return { messageId: `test-${sent.length}` };
  },
});

function resetAll() {
  for (const file of [EMAIL_QUEUE, EMAIL_LOCK, TELEGRAM_QUEUE]) {
    try { fs.unlinkSync(file); } catch (_) {}
  }
  sent = [];
  failNextSend = null;
  telegramCalls = 0;
}

// ---- Test runner ----
let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS: ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL: ${name} — ${err.message}`);
  }
}

resetAll();

// ---- Configuration ----
await test('getEmailRecipients parses, validates and deduplicates', () => {
  assert.deepStrictEqual(getEmailRecipients(), ['a@example.com', 'B@Example.com']);
});

await test('isValidEmail accepts valid and rejects invalid addresses', () => {
  assert.ok(isValidEmail('user@example.com'));
  assert.ok(!isValidEmail('not-an-email'));
  assert.ok(!isValidEmail('a@b'));
  assert.ok(!isValidEmail(''));
});

await test('emailEnabled is true only when fully configured', () => {
  assert.ok(emailEnabled());
  const before = process.env.SMTP_PASSWORD;
  process.env.SMTP_PASSWORD = '';
  assert.ok(!emailEnabled());
  process.env.SMTP_PASSWORD = before;
});

// ---- Email content ----
await test('email content includes required fields, plain text and Dhaka time', () => {
  const { subject, text, html } = buildEmailContent({
    title: 'Exam Schedule Released',
    message: 'New dates are available.',
    url: URL,
    detectedAt: new Date('2026-10-29T05:30:00Z'),
  });
  assert.strictEqual(subject, '[TOLC Watch] Exam Schedule Released');
  assert.ok(text.includes('WEBSITE MONITORING ALERT'));
  assert.ok(text.includes('TOLC CEnT-S'));
  assert.ok(text.includes('Oct 29, 2026, 11:30 AM (Asia/Dhaka)'));
  assert.ok(text.includes(URL));
  assert.ok(text.includes('Automated Website Monitoring System'));
  assert.ok(html.includes('Website Monitoring Alert'));
  assert.ok(html.includes('View Website Update'));
  assert.ok(html.includes('Automated Website Monitoring System'));
  assert.ok(html.includes('Oct 29, 2026, 11:30 AM (Asia/Dhaka)'));
  assert.ok(html.includes('href="https://testcisia.it/calendario.php?tolc=cents&amp;lingua=inglese"'));
});

await test('untrusted content is HTML-escaped', () => {
  const { html, text } = buildEmailContent({
    title: '<b>Alert</b>',
    message: '<script>alert("x")</script> & more',
    url: URL,
  });
  assert.ok(html.includes('&lt;b&gt;Alert&lt;/b&gt;'));
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'));
  assert.ok(html.includes('&amp; more'));
  assert.ok(!html.includes('<script>alert'));
  assert.ok(text.includes('<script>alert("x")</script>'), 'plain text keeps raw content');
});

// ---- Delivery ----
await test('sendEmail delivers once via BCC and records sent status', async () => {
  resetAll();
  const ok = await sendEmail({ title: 'Release', message: 'Dates are out', url: URL });
  assert.ok(ok);
  assert.strictEqual(sent.length, 1);
  const mail = sent[0];
  assert.strictEqual(mail.to, 'sender@gmail.com', 'To is the sender');
  assert.strictEqual(mail.bcc, 'a@example.com, B@Example.com', 'all recipients in BCC');
  assert.ok(!mail.to.includes('a@example.com'), 'recipients not exposed in To');
  assert.ok(mail.subject.includes('Release'));
  assert.ok(mail.text.includes('Dates are out'));
  assert.ok(mail.html.includes('Dates are out'));
  const queue = JSON.parse(fs.readFileSync(EMAIL_QUEUE, 'utf8'));
  assert.strictEqual(queue.entries[0].status, 'sent');
  assert.ok(queue.entries[0].sentAt);
  assert.ok(!JSON.stringify(queue).includes('a@example.com'), 'queue does not store recipients');
});

await test('duplicate email for the same update is suppressed', async () => {
  resetAll();
  await sendEmail({ title: 'Dup', message: 'same', url: URL });
  const first = sent.length;
  const ok = await sendEmail({ title: 'Dup', message: 'same', url: URL });
  assert.ok(ok, 'duplicate suppressed without error');
  assert.strictEqual(sent.length, first, 'no extra email sent');
});

await test('force resends an already-delivered email', async () => {
  resetAll();
  await sendEmail({ title: 'Force', message: 'same', url: URL });
  const ok = await sendEmail({ title: 'Force', message: 'same', url: URL, force: true });
  assert.ok(ok);
  assert.strictEqual(sent.length, 2);
});

await test('failed email is queued and retried on the next run', async () => {
  resetAll();
  failNextSend = 'SMTP connection timeout';
  const ok = await sendEmail({ title: 'Retry', message: 'later', url: URL });
  assert.ok(!ok);
  let queue = JSON.parse(fs.readFileSync(EMAIL_QUEUE, 'utf8'));
  assert.strictEqual(queue.entries[0].status, 'failed');
  assert.strictEqual(queue.entries[0].attempts, 1);

  failNextSend = null;
  await processEmailQueue();
  queue = JSON.parse(fs.readFileSync(EMAIL_QUEUE, 'utf8'));
  assert.strictEqual(queue.entries[0].status, 'sent');
  assert.strictEqual(sent.length, 1);
});

await test('missing credentials skip email without throwing', async () => {
  resetAll();
  const before = process.env.SMTP_PASSWORD;
  process.env.SMTP_PASSWORD = '';
  const ok = await sendEmail({ title: 'No creds', message: 'x', url: URL });
  process.env.SMTP_PASSWORD = before;
  assert.ok(!ok);
  assert.strictEqual(sent.length, 0);
});

await test('sendTestEmail uses the same SMTP path and reports success', async () => {
  resetAll();
  const ok = await sendTestEmail();
  assert.ok(ok);
  assert.strictEqual(sent.length, 1);
  assert.ok(sent[0].subject.includes('Test email'));
});

// ---- Independence from Telegram ----
await test('sendNotification sends Telegram and email independently', async () => {
  resetAll();
  const ok = await sendNotification('integration update', 0, {
    title: 'Integration',
    url: URL,
  });
  assert.ok(ok);
  assert.strictEqual(telegramCalls, 1, 'Telegram called');
  assert.strictEqual(sent.length, 1, 'email sent');
});

await test('email failure does not prevent Telegram delivery', async () => {
  resetAll();
  failNextSend = 'SMTP down';
  const ok = await sendNotification('email fails only', 0, {
    title: 'Email fails',
    url: URL,
  });
  assert.ok(ok, 'Telegram success makes the overall result true');
  assert.strictEqual(telegramCalls, 1);
  assert.strictEqual(sent.length, 0);
});

await test('Telegram failure does not prevent email delivery', async () => {
  resetAll();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 500,
    ok: false,
    json: async () => ({ ok: false, error_code: 500, description: 'Internal Error' }),
    text: async () => '{}',
  });
  try {
    const ok = await sendNotification('telegram fails only', 0, {
      title: 'Telegram fails',
      url: URL,
    });
    assert.ok(ok, 'email success makes the overall result true');
    assert.strictEqual(sent.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('SMTP password is never written to logs', async () => {
  resetAll();
  const logs = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));
  try {
    failNextSend = 'auth failed for super-secret-app-password';
    await sendEmail({ title: 'Log leak', message: 'x', url: URL });
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  const output = logs.join(' ');
  assert.ok(!output.includes('super-secret-app-password'), 'password leaked into logs');
  assert.ok(output.includes('[redacted]'), 'password was redacted');
});

// ---- Summary ----
resetAll();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
