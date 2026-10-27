// timezone.js — IANA time zone helpers (no dependencies, uses Intl).

export const DEFAULT_TIMEZONE = 'UTC';

/** Canonical IANA name for `timeZone` (e.g. "europe/vilnius" -> "Europe/Vilnius"), or null if unknown. */
export function canonicalTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone.trim()) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timeZone.trim() }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

export function isValidTimeZone(timeZone) {
  return canonicalTimeZone(timeZone) !== null;
}

/** Calendar date of `date` in `timeZone` as { year, month (1-12), day }. Unknown zones fall back to UTC. */
export function localDateParts(date, timeZone = DEFAULT_TIMEZONE) {
  const zone = canonicalTimeZone(timeZone) ?? DEFAULT_TIMEZONE;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** "YYYY-MM-DD" for `date` in `timeZone`. */
export function localDateKey(date, timeZone = DEFAULT_TIMEZONE) {
  const { year, month, day } = localDateParts(date, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

let zoneList = null;

/** Up to `limit` IANA zone names containing `query` (case-insensitive), for autocomplete. */
export function searchTimeZones(query = '', limit = 25) {
  if (!zoneList) {
    const supported = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    zoneList = [DEFAULT_TIMEZONE, ...supported.filter((zone) => zone !== DEFAULT_TIMEZONE)];
  }
  const needle = String(query).trim().toLowerCase().replace(/\s+/g, '_');
  return zoneList.filter((zone) => zone.toLowerCase().includes(needle)).slice(0, limit);
}
