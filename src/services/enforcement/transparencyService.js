// transparencyService.js — the numbers behind the public /transparency page
// (services/site/pages/transparency.js): per calendar month (UTC), for the last six
// completed months and the current one, how many warns, mutes, kicks and bans were
// given, how many appeals came in and how they were decided.
//
// Numbers only: nothing here selects a name, an ID, a case code, a reason or a moderator.
//
// What is counted (mod_cases of the main server, by created_at):
//   - is_test = FALSE      /test simulations are real rows but never acted on
//   - is_imported = FALSE  legacy warns imported as history are not counted anywhere
//   - voided_at IS NULL    /case void: a mistake; it no longer counts. Voided cases are
//                          shown in a separate "voided" column instead, so mistakes stay visible.
//   - bans: is_auto marks the automatic warn-ladder bans (enforcementService.js isAuto),
//     shown as "of which automatic"; automod cases have reason_key 'automod:…'.
// Appeals (mod_appeals kind 'appeal', by the appeal's created_at) are joined to their case
// so the server, test and imported filters apply. Appeals on a case voided later still
// count: the appeal happened. 'closed' appeals (closed without a decision) count as received
// only. Staff reports (kind 'report') are not appeals and are left out.
//
// Small-number privacy: a count of 1 or 2 is shown as "fewer than 3" (maskCount), and a
// median is only shown when at least 3 appeals were decided. A total whose column has a
// masked month is shown as "at least N", so the masked month cannot be worked out.

import { query, T } from './db.js';

export const REPORT_MONTHS = 7; // six completed months + the current one
export const SMALL_COUNT = 3;
export const CASE_COLUMNS = ['warns', 'mutes', 'kicks', 'bans', 'ladderBans', 'automod', 'voided'];
export const APPEAL_COLUMNS = ['received', 'accepted', 'denied', 'open'];

/** 'YYYY-MM' of a Date in UTC. */
export function monthKey(date) {
    return date.toISOString().slice(0, 7);
}

/** The report's months, oldest first: [{ key: 'YYYY-MM', start: Date, current }]. */
export function reportMonths(now = new Date()) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    return Array.from({ length: REPORT_MONTHS }, (_, i) => {
        const start = new Date(Date.UTC(year, month - (REPORT_MONTHS - 1) + i, 1));
        return { key: monthKey(start), start, current: i === REPORT_MONTHS - 1 };
    });
}

// date_trunc in UTC whatever the session time zone is; returned as text so no
// time-zone conversion happens on the way to JavaScript.
const MONTH_OF = (column) => `to_char(date_trunc('month', ${column} AT TIME ZONE 'UTC'), 'YYYY-MM')`;
const COUNTED = 'c.voided_at IS NULL';

/** SQL + params: per month, the counts of the main server's cases. */
export function casesQuery(guildId, since) {
    return {
        text: `SELECT ${MONTH_OF('c.created_at')} AS month,
                      COUNT(*) FILTER (WHERE c.type = 'warn' AND ${COUNTED})::int AS warns,
                      COUNT(*) FILTER (WHERE c.type = 'mute' AND ${COUNTED})::int AS mutes,
                      COUNT(*) FILTER (WHERE c.type = 'kick' AND ${COUNTED})::int AS kicks,
                      COUNT(*) FILTER (WHERE c.type = 'ban' AND ${COUNTED})::int AS bans,
                      COUNT(*) FILTER (WHERE c.type = 'ban' AND c.is_auto AND ${COUNTED})::int AS ladder_bans,
                      COUNT(*) FILTER (WHERE c.reason_key LIKE 'automod:%' AND ${COUNTED})::int AS automod,
                      COUNT(*) FILTER (WHERE c.voided_at IS NOT NULL)::int AS voided
                 FROM ${T.cases} c
                WHERE c.guild_id = $1 AND c.created_at >= $2 AND c.is_test = FALSE AND c.is_imported = FALSE
                GROUP BY 1`,
        params: [guildId, since],
    };
}

const DECIDED = "a.status IN ('accepted', 'denied') AND a.decided_at IS NOT NULL";

/**
 * SQL + params: per month, the appeals received and how they ended, with the median hours
 * from appeal to decision; GROUPING SETS adds one total row (is_total) with the median over
 * all months (a median cannot be added up from the months).
 */
export function appealsQuery(guildId, since) {
    return {
        text: `SELECT m.month, GROUPING(m.month) = 1 AS is_total,
                      COUNT(*)::int AS received,
                      COUNT(*) FILTER (WHERE m.status = 'accepted')::int AS accepted,
                      COUNT(*) FILTER (WHERE m.status = 'denied')::int AS denied,
                      COUNT(*) FILTER (WHERE m.status = 'pending')::int AS open,
                      COUNT(m.decision_hours)::int AS decided,
                      percentile_cont(0.5) WITHIN GROUP (ORDER BY m.decision_hours) AS median_hours
                 FROM (SELECT ${MONTH_OF('a.created_at')} AS month, a.status,
                              CASE WHEN ${DECIDED} THEN EXTRACT(EPOCH FROM (a.decided_at - a.created_at)) / 3600.0 END AS decision_hours
                         FROM ${T.appeals} a
                         JOIN ${T.cases} c ON c.case_code = a.case_code
                        WHERE a.kind = 'appeal' AND c.guild_id = $1 AND a.created_at >= $2
                          AND c.is_test = FALSE AND c.is_imported = FALSE) m
                GROUP BY GROUPING SETS ((m.month), ())`,
        params: [guildId, since],
    };
}

const int = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};
const hours = (value) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Math.max(0, Number(value)));

/**
 * Raw rows → the report: { months: [{ key, start, current, cases, appeals }], totals, generatedAt }.
 * Months without rows are zeros. Rows outside the window are ignored.
 */
export function aggregateReport({ caseRows = [], appealRows = [] }, now = new Date()) {
    const months = reportMonths(now).map((m) => ({
        ...m,
        cases: Object.fromEntries(CASE_COLUMNS.map((k) => [k, 0])),
        appeals: { ...Object.fromEntries(APPEAL_COLUMNS.map((k) => [k, 0])), decided: 0, medianHours: null },
    }));
    const byKey = new Map(months.map((m) => [m.key, m]));
    for (const row of caseRows) {
        const month = byKey.get(String(row.month));
        if (!month) continue;
        month.cases = {
            warns: int(row.warns), mutes: int(row.mutes), kicks: int(row.kicks), bans: int(row.bans),
            ladderBans: int(row.ladder_bans), automod: int(row.automod), voided: int(row.voided),
        };
    }
    let totalAppeals = null;
    for (const row of appealRows) {
        const appeals = {
            received: int(row.received), accepted: int(row.accepted), denied: int(row.denied), open: int(row.open),
            decided: int(row.decided), medianHours: hours(row.median_hours),
        };
        if (row.is_total === true || row.is_total === 't') totalAppeals = appeals;
        else if (byKey.has(String(row.month))) byKey.get(String(row.month)).appeals = appeals;
    }
    const sum = (pick, keys) => Object.fromEntries(keys.map((k) => [k, months.reduce((n, m) => n + pick(m)[k], 0)]));
    const appealTotals = sum((m) => m.appeals, [...APPEAL_COLUMNS, 'decided']);
    return {
        months,
        totals: {
            cases: sum((m) => m.cases, CASE_COLUMNS),
            // The SQL total row has the median over every appeal in the window; the counts are
            // the same as the sum of the months (it reads the same rows).
            appeals: { ...appealTotals, medianHours: totalAppeals ? totalAppeals.medianHours : null },
        },
        generatedAt: now,
    };
}

/** Reads both aggregates (two queries) and builds the report. Throws on any database error. */
export async function readTransparencyReport(guildId, { now = new Date(), run = query } = {}) {
    if (!guildId) throw new Error('MAIN_GUILD_ID is not set');
    const since = reportMonths(now)[0].start;
    const cases = casesQuery(guildId, since);
    const appeals = appealsQuery(guildId, since);
    const [caseResult, appealResult] = await Promise.all([run(cases.text, cases.params), run(appeals.text, appeals.params)]);
    if (!caseResult?.rows || !appealResult?.rows) throw new Error('transparency report: no rows from the database');
    return aggregateReport({ caseRows: caseResult.rows, appealRows: appealResult.rows }, now);
}

// ── Display helpers (pure) ────────────────────────────────────────────────

/** { text, masked }: 0 and 3+ as the number, 1–2 as "fewer than 3". */
export function maskCount(n) {
    const value = int(n);
    if (value > 0 && value < SMALL_COUNT) return { text: `fewer than ${SMALL_COUNT}`, masked: true };
    return { text: value.toLocaleString('en-US'), masked: false };
}

/**
 * A column total. When a month in the column is masked, the exact total would reveal it, so
 * it becomes "at least N" (N = the shown months + 1 for each masked one). A total of 1–2 is masked too.
 */
export function maskTotal(values) {
    const counts = values.map(int);
    const total = counts.reduce((a, b) => a + b, 0);
    if (total > 0 && total < SMALL_COUNT) return { text: `fewer than ${SMALL_COUNT}`, masked: true };
    const hidden = counts.filter((n) => n > 0 && n < SMALL_COUNT);
    if (!hidden.length) return { text: total.toLocaleString('en-US'), masked: false };
    const floor = total - hidden.reduce((a, b) => a + b, 0) + hidden.length;
    return { text: `at least ${floor.toLocaleString('en-US')}`, masked: true };
}

/** "5 hours", "3.5 days", "under an hour"; null when fewer than 3 appeals were decided. */
export function medianText(medianHours, decided) {
    if (int(decided) < SMALL_COUNT || medianHours === null || medianHours === undefined) return null;
    const h = Number(medianHours);
    if (!Number.isFinite(h)) return null;
    if (h < 1) return 'under an hour';
    if (h < 48) {
        const rounded = Math.round(h);
        return `${rounded} hour${rounded === 1 ? '' : 's'}`;
    }
    const days = Math.round((h / 24) * 10) / 10;
    return `${days} days`;
}

/**
 * The cached reader for the site: () → Promise<report>. One read per 10 minutes, shared by
 * concurrent views; a failed read is not cached (the next view tries again).
 */
export const TRANSPARENCY_CACHE_MS = 10 * 60 * 1000;
export function createTransparencyReader({ guildId, read = readTransparencyReport, now = () => Date.now(), ttlMs = TRANSPARENCY_CACHE_MS } = {}) {
    let hit = null;
    return () => {
        if (hit && hit.until > now()) return hit.promise;
        const id = typeof guildId === 'function' ? guildId() : guildId;
        const promise = Promise.resolve().then(() => read(id, { now: new Date(now()) }));
        const entry = { promise, until: now() + ttlMs };
        hit = entry;
        promise.catch(() => { if (hit === entry) hit = null; });
        return promise;
    };
}
