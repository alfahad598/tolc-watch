import dotenv from 'dotenv';
import assert from 'node:assert';
import fs from 'fs';

dotenv.config();

// ---- Test environment (read lazily by telegram.js, so this works despite ESM hoisting) ----
process.env.TELEGRAM_BOT_TOKEN = '123456789:ABCdefGHIjklMNOpqrsTUVwxyz123456789';
process.env.TELEGRAM_ALLOWED_CHAT_IDS = '123456789, -987654321, invalid-id, , 123456789';
process.env.TELEGRAM_NOTIFICATIONS_ENABLED = 'true';
process.env.TELEGRAM_TEST_FAST = '1';
process.env.TELEGRAM_QUEUE_FILE = './.test-telegram-queue.json';

const URL = 'https://testcisia.it/calendario.php?tolc=cents&lingua=inglese';
const QUEUE_FILE = '.test-telegram-queue.json';
const LOCK_FILE = 'telegram-queue.lock';

function resetQueue() {
  try { fs.unlinkSync(QUEUE_FILE); } catch (_) {}
  try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
}

import {
  telegramEnabled,
  getAllowedChatIds,
  isValidBotToken,
  sendTelegram,
  telegramNotificationsEnabled,
  getTelegramStatus,
  processTelegramQueue,
} from './telegram.js';
import { sendNotification } from './notify.js';

// ---- Mocked Telegram Bot API (no real network, no real notifications) ----
let fetchHandler;
const fetchCalls = [];
globalThis.fetch = async (url, opts = {}) => {
  const record = { url: String(url), method: opts.method, body: opts.body };
  fetchCalls.push(record);
  const res = fetchHandler ? fetchHandler(record) : okJson();
  return {
    status: res.status,
    ok: res.status >= 200 && res.status < 300,
    json: async () => res.body,
    text: async () => JSON.stringify(res.body),
  };
};

function okJson(extra = {}) {
  return { status: 200, body: { ok: true, result: { message_id: 1 }, ...extra } };
}
function clientError(code, description) {
  return { status: code, body: { ok: false, error_code: code, description } };
}
function bodyOf(call) {
  return JSON.parse(call.body);
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

resetQueue();

// ---- Configuration ----
await test('getAllowedChatIds parses, validates and deduplicates chat IDs', () => {
  assert.deepStrictEqual(getAllowedChatIds(), ['123456789', '-987654321']);
});

await test('isValidBotToken accepts real format and rejects garbage', () => {
  assert.ok(isValidBotToken('123456789:ABCdefGHIjklMNOpqrsTUVwxyz123456789'));
  assert.ok(!isValidBotToken('not-a-token'));
  assert.ok(!isValidBotToken(''));
});

await test('telegramEnabled is true when fully configured', () => {
  assert.ok(telegramEnabled());
});

await test('disabled when TELEGRAM_NOTIFICATIONS_ENABLED=false', async () => {
  const before = process.env.TELEGRAM_NOTIFICATIONS_ENABLED;
  process.env.TELEGRAM_NOTIFICATIONS_ENABLED = 'false';
  assert.ok(!telegramEnabled());
  assert.strictEqual(await sendTelegram({ title: 't', message: 'm', url: 'u' }), false);
  process.env.TELEGRAM_NOTIFICATIONS_ENABLED = before;
});

// ---- Delivery ----
await test('delivers to every valid recipient and records sent status', async () => {
  resetQueue();
  fetchCalls.length = 0;
  fetchHandler = () => okJson();
  const ok = await sendTelegram({
    title: 'DATES RELEASED',
    message: 'New dates available',
    url: URL,
  });
  assert.ok(ok, 'sendTelegram should return true');
  assert.strictEqual(fetchCalls.length, 2, 'one API call per valid recipient');
  for (const call of fetchCalls) {
    assert.ok(call.url.endsWith('/sendMessage'), `sendMessage endpoint: ${call.url}`);
    assert.strictEqual(call.method, 'POST');
    const body = bodyOf(call);
    assert.ok(['123456789', '-987654321'].includes(body.chat_id), `chat_id ${body.chat_id}`);
    assert.ok(body.text.includes('🚨 NEW RELEASE DETECTED!'));
    assert.ok(body.text.includes('DATES RELEASED'));
    assert.ok(body.text.includes(URL));
    assert.ok(!Object.hasOwn(body, 'parse_mode'), 'plain text: no parse_mode');
  }
  const data = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  assert.strictEqual(data.entries.length, 1);
  assert.ok(data.entries[0].recipients.every((r) => r.status === 'sent'));
  assert.ok(data.entries[0].recipients.every((r) => r.sentAt));
});

await test('one recipient failure does not block other recipients', async () => {
  resetQueue();
  fetchCalls.length = 0;
  fetchHandler = (call) => {
    const body = bodyOf(call);
    if (body.chat_id === '-987654321') {
      return clientError(400, 'Bad Request: chat not found');
    }
    return okJson();
  };
  const ok = await sendTelegram({ title: 'T', message: 'm', url: URL });
  assert.ok(ok, 'at least one recipient succeeded');
  const sent = fetchCalls.filter((c) => bodyOf(c).chat_id === '123456789');
  const failed = fetchCalls.filter((c) => bodyOf(c).chat_id === '-987654321');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(failed.length, 1, 'invalid chat ID tried once (400 is permanent, no retry)');
  const data = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  const statuses = data.entries[0].recipients.map((r) => r.status).sort();
  assert.deepStrictEqual(statuses, ['failed', 'sent']);
});

await test('invalid bot token fails fast without retries', async () => {
  const beforeToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = 'not-a-valid-token';
  resetQueue();
  fetchCalls.length = 0;
  fetchHandler = () => clientError(401, 'Unauthorized');
  const ok = await sendTelegram({ title: 'T', message: 'm', url: URL });
  assert.ok(!ok);
  assert.strictEqual(fetchCalls.length, 0, 'invalid token format is rejected before any API call');
  process.env.TELEGRAM_BOT_TOKEN = beforeToken;
});

await test('HTTP 429 rate limit is honoured and retried', async () => {
  resetQueue();
  fetchCalls.length = 0;
  let attempts = 0;
  process.env.TELEGRAM_BOT_TOKEN = '123456789:ABCdefGHIjklMNOpqrsTUVwxyz123456789';
  process.env.TELEGRAM_ALLOWED_CHAT_IDS = '123456789';
  fetchHandler = () => {
    attempts += 1;
    if (attempts === 1) {
      return { status: 429, body: { ok: false, error_code: 429, parameters: { retry_after: 1 }, description: 'Too Many Requests' } };
    }
    return okJson();
  };
  const ok = await sendTelegram({ title: 'T', message: 'm', url: URL });
  assert.ok(ok);
  assert.strictEqual(attempts, 2, 'first call rate-limited, second succeeded');
  // restore multi-recipient env
  process.env.TELEGRAM_ALLOWED_CHAT_IDS = '123456789, -987654321, invalid-id, , 123456789';
});

await test('transient 5xx errors retry with backoff then fail', async () => {
  resetQueue();
  fetchCalls.length = 0;
  let attempts = 0;
  fetchHandler = () => {
    attempts += 1;
    return { status: 500, body: { ok: false, error_code: 500, description: 'Internal Error' } };
  };
  const ok = await sendTelegram({ title: 'T', message: 'm', url: URL });
  assert.ok(!ok);
  assert.strictEqual(attempts, 10, '5 attempts per recipient x 2 recipients');
  const data = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  assert.ok(data.entries[0].recipients.every((r) => r.status === 'failed'));
  assert.ok(data.entries[0].recipients.every((r) => r.lastError));
});

// ---- Message format (Asia/Dhaka timestamps, no injection vectors) ----
await test('message uses the required format with Asia/Dhaka timestamp', async () => {
  resetQueue();
  fetchCalls.length = 0;
  fetchHandler = () => okJson();
  await sendTelegram({ title: 'Calendar changed', message: 'Some updated text', url: URL });
  const body = bodyOf(fetchCalls[0]);
  const text = body.text;
  assert.ok(text.includes('🚨 NEW RELEASE DETECTED!'));
  assert.ok(text.includes('🌐 Website: Calendar changed'));
  assert.ok(text.includes('📢 Release: Some updated text'));
  assert.ok(/\w{3} \d{1,2}, \d{4}, \d{2}:\d{2} (AM|PM) \(Asia\/Dhaka\)/.test(text), `Dhaka timestamp in: ${text}`);
  assert.ok(text.includes('🔗 View Release:\n' + URL));
});

// ---- Deduplication ----
await test('duplicate release notification is suppressed', async () => {
  resetQueue();
  fetchCalls.length = 0;
  fetchHandler = () => okJson();
  await sendTelegram({ title: 'Dup', message: 'm', url: URL });
  const firstCallCount = fetchCalls.length;
  const okAgain = await sendTelegram({ title: 'Dup', message: 'm', url: URL });
  assert.ok(okAgain, 'duplicate suppressed without error');
  assert.strictEqual(fetchCalls.length, firstCallCount, 'no extra API calls for duplicate');
});

// ---- Queue recovery (simulates restart) ----
await test('processTelegramQueue retries pending entries after restart', async () => {
  resetQueue();
  fetchCalls.length = 0;
  fetchHandler = () => okJson();
  fs.writeFileSync(
    QUEUE_FILE,
    JSON.stringify({
      entries: [
        {
          id: 'e1',
          dedupeKey: 'recovered-key',
          title: 'Recovered release',
          message: 'pending text',
          url: URL,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          recipients: [{ chatId: '123456789', status: 'pending', attempts: 0 }],
        },
      ],
    }),
  );
  await processTelegramQueue();
  const data = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  assert.strictEqual(fetchCalls.length, 1);
  assert.strictEqual(data.entries[0].recipients[0].status, 'sent');
});

// ---- Integration with existing sendNotification pipeline ----
await test('sendNotification delivers via Telegram alongside other providers', async () => {
  resetQueue();
  fetchCalls.length = 0;
  fetchHandler = () => okJson();
  const ok = await sendNotification('pipeline test message', 0, {
    title: 'Pipeline test',
    url: URL,
  });
  assert.ok(ok);
  const tgCalls = fetchCalls.filter((c) => c.url.endsWith('/sendMessage'));
  assert.strictEqual(tgCalls.length, 2, 'one Telegram API call per recipient');
});

// ---- Security: credentials never logged ----
await test('bot token is never written to logs', async () => {
  const beforeToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = '123456SECRET:ABCdefGHIjklMNOpqrsTUVwxyz123456789';
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    resetQueue();
    fetchCalls.length = 0;
    fetchHandler = () => clientError(401, 'Unauthorized');
    await sendTelegram({ title: 'T', message: 'm', url: URL });
  } finally {
    console.log = origLog;
    process.env.TELEGRAM_BOT_TOKEN = beforeToken;
  }
  const logText = logs.join(' ');
  assert.ok(!logText.includes('123456SECRET'), 'token leaked into console output');
});

// ---- Status snapshot ----
await test('getTelegramStatus reports config without exposing the full token', () => {
  const st = getTelegramStatus();
  assert.ok(st.enabled);
  assert.strictEqual(st.recipients, 2);
  assert.ok(st.token.includes('…'), `masked token: ${st.token}`);
  assert.ok(!st.token.includes('ABCdefGHIjklMNOpqrsTUVwxyz123456789'), 'full token not exposed');
  assert.ok(st.byStatus.sent >= 0);
});

// ---- Summary ----
resetQueue();
try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
