import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const checker = fileURLToPath(new URL('./check-tolc.js', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'tolc-checker-'));
const initial = JSON.stringify({ failCount: 4, sessions: {}, revision: 0 });
const env = { ...process.env, PUSHOVER_TOKEN: 'fake', PUSHOVER_USER: 'fake',
  CALLMEBOT_PHONE: '', CALLMEBOT_APIKEY: '', TELEGRAM_BOT_TOKEN: '',
  TELEGRAM_ALLOWED_CHAT_IDS: '', SMTP_USER: '', SMTP_PASSWORD: '', EMAIL_RECIPIENTS: '' };
function run(mock, args = ['--dry-run']) {
  writeFileSync(join(dir, 'state.json'), initial);
  const hook = `globalThis.fetch = ${mock};`;
  const result = spawnSync(process.execPath,
    ['--import', `data:text/javascript,${encodeURIComponent(hook)}`, checker, ...args],
    { cwd: dir, env, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), initial, 'state must remain unchanged');
  return result;
}
try {
  for (const mock of [
    `async () => { throw new Error('offline'); }`,
    `async () => ({ status: 403, text: async () => 'Forbidden' })`,
    `async () => ({ status: 200, text: async () => '<body>tiny</body>' })`,
    `async () => ({ status: 200, text: async () => '<body>' + 'Unexpected layout '.repeat(20) + '</body>' })`,
  ]) {
    const result = run(mock);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /sending one failure alert|\[Pushover\]/);
  }
  const valid = run(`async () => ({ status: 200, text: async () => '<body>' + 'Calendar '.repeat(20) + 'Nessuna data disponibile</body>' })`);
  assert.equal(valid.status, 0, valid.stdout + valid.stderr);
  const html = '<body>Calendar registration sessions currently available for booking<table><tr><th>UNIVERSITA</th><th>DATA TEST</th></tr><tr><td>Example University</td><td>26/11/2026</td></tr></table></body>';
  const failedDelivery = run(`async (url) => String(url).includes('testcisia.it')
    ? { status: 200, text: async () => ${JSON.stringify(html)} }
    : { status: 500, json: async () => ({ status: 0 }) }`, []);
  assert.equal(failedDelivery.status, 1, failedDelivery.stdout + failedDelivery.stderr);
  assert.match(failedDelivery.stdout, /state.json NOT saved/);
  console.log('PASS: dry-run failures preserve state and never alert; failed delivery exits nonzero for retry');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
