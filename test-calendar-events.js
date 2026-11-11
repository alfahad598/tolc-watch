import assert from 'node:assert/strict';
import {
  parseSessions,
  toStoredSessions,
  diffSessions,
  hasNotifiableChange,
  eventId,
} from './calendar-events.js';

const HEAD =
  '<table><tr><th>MODALITÀ</th><th>UNIVERSITÀ</th><th>REGIONE<br>STATO ESTERO</th><th>CITTÀ</th>' +
  '<th>FINE ISCRIZIONI</th><th>POSTI</th><th>STATO</th><th>DATA TEST</th></tr>';
const row = (uni, city, deadline, seats, status, date, mode = 'CENT@UNI') =>
  `<tr><td>${mode}</td><td>${uni}</td><td>REG</td><td>${city}</td><td>${deadline}</td>` +
  `<td>${seats}</td><td>${status}</td><td>${date}</td></tr>`;
const page = (...rows) => `<html><body>${HEAD}${rows.join('')}</table></body></html>`;

const trieste = (seats = '95', status = 'POSTI DISPONIBILI', deadline = '20/11/2026') =>
  row('Univ Trieste', 'TRIESTE', deadline, seats, status, '26/11/2026');
const roma = (seats = '---', status = 'POSTI ESAURITI') =>
  row('Sapienza', 'ROMA', '20/11/2026', seats, status, '26/11/2026', 'CENT@CASA');
const messinaDec = row('Univ Messina', 'MESSINA', '11/12/2026', '66', 'POSTI DISPONIBILI', '17/12/2026');

const now = new Date('2026-11-11T12:00:00Z');
let stored = {};
function step(html, when = now) {
  const sessions = parseSessions(html);
  const diff = diffSessions(stored, sessions, when);
  stored = diff.current;
  return diff;
}

// Parsing
const parsed = parseSessions(page(trieste(), roma()));
assert.equal(parsed.length, 2);
assert.equal(parsed[0].testDate, '26/11/2026');
assert.equal(parsed[0].seats, '95');
assert.equal(parseSessions('<html><body><p>Nessuna data disponibile</p></body></html>'), null);

// First release: everything is new
let d = step(page(trieste(), roma()));
assert.equal(d.added.length, 2);
assert.ok(hasNotifiableChange(d));

// Seat count changes only: silent (this was the old false-alarm source)
d = step(page(trieste('80'), roma()));
assert.ok(!hasNotifiableChange(d));
d = step(page(trieste('12'), roma()));
assert.ok(!hasNotifiableChange(d));

// New exam date released: alert
d = step(page(trieste('12'), roma(), messinaDec));
assert.deepEqual(d.added.map((s) => s.testDate), ['17/12/2026']);
// Retrying the same change (seats moved meanwhile) keeps the same event id
const before = Object.fromEntries(Object.entries(stored).filter(([, s]) => s.testDate !== '17/12/2026'));
assert.equal(eventId(5, diffSessions(before, parseSessions(page(trieste('3'), roma(), messinaDec)), now)), eventId(5, d));

// Sold out: silent. Seats reopen: alert.
d = step(page(trieste('---', 'POSTI ESAURITI'), roma(), messinaDec));
assert.ok(!hasNotifiableChange(d));
assert.equal(d.soldOut.length, 1);
d = step(page(trieste('4'), roma(), messinaDec));
assert.equal(d.reopened.length, 1);
assert.ok(hasNotifiableChange(d));

// Deadline moved: alert
d = step(page(trieste('4', 'POSTI DISPONIBILI', '22/11/2026'), roma(), messinaDec));
assert.equal(d.deadlineChanged.length, 1);
assert.equal(d.deadlineChanged[0].oldDeadline, '20/11/2026');

// Session removed after its deadline passed: silent
d = step(page(messinaDec), new Date('2026-11-25T12:00:00Z'));
assert.equal(d.removedExpired.length, 2);
assert.ok(!hasNotifiableChange(d));

// Session removed before its deadline: alert
d = step(page(), now);
assert.equal(d.removedEarly.length, 1);
assert.ok(hasNotifiableChange(d));

// Stored state carries no seat counts, so it is stable across seat changes
assert.deepEqual(toStoredSessions(parseSessions(page(trieste('1')))), toStoredSessions(parseSessions(page(trieste('90')))));

console.log('PASS: new dates, reopened seats, deadline changes and early removals alert; seat counts, sell-outs and expired sessions stay silent');
