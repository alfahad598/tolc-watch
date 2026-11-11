// Session-level change detection for the CISIA calendar table.
//
// The page lists one row per exam session. Seat counts ("95 POSTI") change all
// the time, so hashing the whole page produced a "schedule updated" alert on
// almost every check. Instead we parse each row into a session and compare
// sessions by identity, alerting only on changes that matter to a candidate.

import { load } from 'cheerio';
import { createHash } from 'crypto';

const COLUMNS = {
  mode: /MODALIT/,
  university: /UNIVERSIT/,
  region: /REGIONE/,
  city: /CITT/,
  deadline: /FINE ISCRIZIONI/,
  seats: /^POSTI/,
  status: /^STATO$/,
  testDate: /DATA TEST/,
};

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// Returns the calendar sessions, or null when no calendar table was found.
export function parseSessions(html) {
  const $ = load(html);
  let sessions = null;
  $('table').each((_, table) => {
    if (sessions) return;
    const headerRow = $(table).find('tr').filter((__, tr) => $(tr).find('th').length > 0).first();
    const headers = headerRow.find('th').map((__, th) => clean($(th).text()).toUpperCase()).get();
    const index = {};
    for (const [field, re] of Object.entries(COLUMNS)) {
      index[field] = headers.findIndex((h) => re.test(h));
    }
    if (index.testDate === -1 || index.university === -1) return;

    sessions = [];
    $(table).find('tr').each((__, tr) => {
      const cells = $(tr).find('td').map((___, td) => clean($(td).text())).get();
      if (cells.length < headers.length - 1) return;
      const row = {};
      for (const [field, i] of Object.entries(index)) row[field] = i === -1 ? '' : cells[i] || '';
      if (!/\d{2}\/\d{2}\/\d{4}/.test(row.testDate)) return;
      sessions.push(row);
    });
  });
  return sessions;
}

export function sessionKey(s) {
  return [s.mode, s.university, s.city, s.testDate].map((v) => clean(v).toUpperCase()).join('|');
}

export function isAvailable(s) {
  return /DISPONIBIL/i.test(s.status || '');
}

function parseDate(ddmmyyyy) {
  const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(ddmmyyyy || '');
  return m ? new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], 23, 59)) : null;
}

// Compact form stored in state.json (seat counts deliberately left out).
export function toStoredSessions(sessions) {
  const out = {};
  for (const s of sessions) {
    out[sessionKey(s)] = {
      mode: s.mode,
      university: s.university,
      city: s.city,
      deadline: s.deadline,
      testDate: s.testDate,
      status: s.status,
    };
  }
  return out;
}

// Compare previous stored sessions with the current page.
// previousSessions: object from state.json, or undefined for the first run.
export function diffSessions(previousSessions, currentSessions, now = new Date()) {
  const current = toStoredSessions(currentSessions);
  const prev = previousSessions || {};
  const added = [];
  const reopened = [];
  const deadlineChanged = [];
  const removedEarly = [];
  const removedExpired = [];
  const soldOut = [];

  for (const [key, s] of Object.entries(current)) {
    const old = prev[key];
    if (!old) {
      added.push(s);
      continue;
    }
    if (isAvailable(s) && !isAvailable(old)) reopened.push(s);
    if (!isAvailable(s) && isAvailable(old)) soldOut.push(s);
    if (old.deadline !== s.deadline) deadlineChanged.push({ ...s, oldDeadline: old.deadline });
  }
  for (const [key, old] of Object.entries(prev)) {
    if (current[key]) continue;
    const deadline = parseDate(old.deadline);
    if (deadline && deadline < now) removedExpired.push(old);
    else removedEarly.push(old);
  }

  return { current, added, reopened, deadlineChanged, removedEarly, removedExpired, soldOut };
}

export function eventId(revision, diff) {
  const parts = [
    ...diff.added.map((s) => `+${sessionKey(s)}`),
    ...diff.reopened.map((s) => `o${sessionKey(s)}`),
    ...diff.deadlineChanged.map((s) => `d${sessionKey(s)}${s.deadline}`),
    ...diff.removedEarly.map((s) => `-${sessionKey(s)}`),
  ].sort();
  const digest = createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex').slice(0, 16);
  return `${revision}:${digest}`;
}

export function hasNotifiableChange(diff) {
  return (
    diff.added.length > 0 ||
    diff.reopened.length > 0 ||
    diff.deadlineChanged.length > 0 ||
    diff.removedEarly.length > 0
  );
}
