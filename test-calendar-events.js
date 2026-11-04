import assert from 'node:assert/strict';
import { detectCalendarEvent } from './calendar-events.js';

let state = null;
function observe(hash, hasDates) {
  const event = detectCalendarEvent(state, { hash, hasDates });
  state = { hash, hasDates, revision: event?.revision ?? state?.revision ?? 0 };
  return event;
}
assert.equal(observe('empty', false), null);
const first = observe('schedule-a', true);
assert.equal(first.kind, 'released');
assert.equal(observe('schedule-a', true), null);
const update = observe('schedule-b', true);
assert.equal(update.kind, 'updated');
assert.notEqual(update.id, first.id);
const retry = detectCalendarEvent(state, { hash: 'schedule-c', hasDates: true });
assert.deepEqual(detectCalendarEvent(state, { hash: 'schedule-c', hasDates: true }), retry);
const returned = observe('schedule-a', true);
assert.notEqual(returned.id, first.id);
assert.equal(observe('empty', false).kind, 'removed');
const rereleased = observe('schedule-a', true);
assert.equal(rereleased.kind, 'released');
assert.notEqual(rereleased.id, first.id);
assert.equal(detectCalendarEvent(null, { hash: 'initial', hasDates: true }).kind, 'released');
console.log('PASS: releases, later updates, unchanged checks, retries, removals and repeated releases');
