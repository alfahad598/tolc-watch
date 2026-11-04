// Each observed transition gets a new identity. Unchanged checks stay silent,
// retries keep the same identity, and returning to earlier content is a new event.
export function detectCalendarEvent(previous, { hash, hasDates }) {
  if (previous?.hash === hash || (!previous?.hash && !hasDates)) return null;
  const revision = (previous?.revision || 0) + 1;
  const kind = hasDates
    ? (previous?.hasDates ? 'updated' : 'released')
    : (previous?.hasDates ? 'removed' : 'changed');
  const titles = {
    released: 'RELEASED',
    updated: 'Exam schedule updated',
    removed: 'Dates removed',
    changed: 'Calendar changed',
  };
  return { kind, title: titles[kind], revision, id: `${revision}:${hash}` };
}
