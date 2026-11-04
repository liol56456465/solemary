// incidentTimeline.js — the raid timeline (dashboard Moderate → Raid timeline).
//
// An incident is a join-raid lockdown (raidService.js). It is opened right after the
// protective steps of the lockdown ran and closed when the lockdown ends. While it runs,
// the steps that are stored nowhere else are recorded here as short events:
//   lockdown_start, lockdown_end, verification (raised / restored), panic (invites and DMs
//   paused / resumed), gate_kick / gate_flag (join gate), automod (what automod did to a
//   member), mass_block (mass-action guard).
// Everything else on the timeline is read from what the bot already stores, at page time:
// joins and leaves (member_events, kept 90 days), cases (mod_cases), dashboard changes
// (dashboard_audit) and the incident report (automod_raid_incidents).
//
// Rules: no message content (a detail is a short label, at most 200 characters, control
// characters removed). At most MAX_EVENTS_PER_INCIDENT events per incident: the bound is
// checked in the same statement as the INSERT, so concurrent writers cannot pass it; the
// rest only bump dropped_events. Incidents are purged RETENTION_DAYS after they ended
// (events go with them, ON DELETE CASCADE) by the daily cron in app.js.
// Recording never throws: a failed write is logged and the protective action goes on.
// Reads throw on a database error (the page then says it could not load).

import { automodConfig } from '../../config/automod.js';
import { pgConfig } from '../../config/database/postgres.js';
import { logger } from '../../utils/logger.js';
import { query as dbQuery } from '../enforcement/db.js';

export const MAX_EVENTS_PER_INCIDENT = 2000;
export const RETENTION_DAYS = 90;
export const MAX_DETAIL = 200;
/** Rows read per merged source (joins, leaves, cases); one more is read to know it was cut. */
export const MAX_SOURCE_ROWS = 2000;
export const MAX_AUDIT_ROWS = 200;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export const TRIGGERS = { join_raid: 'Join raid (many accounts joined at once)' };

/**
 * Every event kind on the timeline. `recorded`: written to incident_events; the others
 * come from existing tables. `group` decides the per-minute counts.
 */
export const EVENT_KINDS = Object.freeze({
    lockdown_start: { label: 'Lockdown started', group: 'steps', recorded: true },
    lockdown_end: { label: 'Lockdown ended', group: 'steps', recorded: true },
    verification: { label: 'Verification level', group: 'steps', recorded: true },
    panic: { label: 'Invites and DMs', group: 'steps', recorded: true },
    gate_kick: { label: 'Join gate kick', group: 'actions', recorded: true },
    gate_flag: { label: 'Join gate flag', group: 'actions', recorded: true },
    automod: { label: 'Automod (no case)', group: 'actions', recorded: true },
    mass_block: { label: 'Mass-action guard', group: 'actions', recorded: true },
    join: { label: 'Joined', group: 'joins', recorded: false },
    leave: { label: 'Left', group: 'leaves', recorded: false },
    case: { label: 'Case', group: 'actions', recorded: false },
    dashboard: { label: 'Dashboard change', group: 'steps', recorded: false },
});

const SNOWFLAKE = /^\d{17,20}$/;
const idOrNull = (value) => (typeof value === 'string' && SNOWFLAKE.test(value) ? value : null);

/** A short, single-line label: control characters removed, at most MAX_DETAIL characters. */
export function cleanDetail(value) {
    if (value === null || value === undefined) return null;
    // eslint-disable-next-line no-control-regex
    const text = String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL - 1)}…` : text;
}

/** A validated event row, or null when the kind is not a recorded one. */
export function normalizeEvent(event, now = Date.now()) {
    if (!event || !EVENT_KINDS[event.kind]?.recorded) return null;
    const at = event.at ? new Date(event.at) : new Date(now);
    return {
        at: Number.isNaN(at.getTime()) ? new Date(now) : at,
        kind: event.kind,
        actorId: idOrNull(event.actorId),
        targetId: idOrNull(event.targetId),
        detail: cleanDetail(event.detail),
    };
}

/**
 * The store. `query` and the table names are injectable for tests.
 */
export function createTimelineStore({ query = dbQuery, tables = pgConfig.tables, maxEvents = MAX_EVENTS_PER_INCIDENT } = {}) {
    const TL = tables.incident_timelines;
    const EV = tables.incident_events;

    /** Opens an incident. Resolves its id (string). Throws on a database error. */
    async function open({ guildId, trigger = 'join_raid', startedAt = new Date() }) {
        if (!TRIGGERS[trigger]) throw new Error(`Unknown incident trigger ${trigger}`);
        const { rows } = await query(
            `INSERT INTO ${TL} (guild_id, trigger_kind, started_at) VALUES ($1, $2, $3) RETURNING id`,
            [guildId, trigger, new Date(startedAt)],
        );
        if (!rows?.[0]?.id) throw new Error('The incident was not stored');
        return String(rows[0].id);
    }

    /**
     * Adds one event. Resolves 'stored', 'dropped' (the incident is full or gone) or
     * 'invalid'. The bound and the insert are one statement. Throws on a database error.
     */
    async function addEvent(incidentId, event, now = Date.now()) {
        const row = normalizeEvent(event, now);
        if (!row || !incidentId) return 'invalid';
        const { rowCount } = await query(
            `WITH slot AS (
                UPDATE ${TL} SET event_count = event_count + 1
                WHERE id = $1 AND event_count < $2
                RETURNING id
            )
            INSERT INTO ${EV} (incident_id, at, kind, actor_id, target_id, detail)
            SELECT id, $3, $4, $5, $6, $7 FROM slot`,
            [incidentId, maxEvents, row.at, row.kind, row.actorId, row.targetId, row.detail],
        );
        if (rowCount === 1) return 'stored';
        await query(`UPDATE ${TL} SET dropped_events = dropped_events + 1 WHERE id = $1`, [incidentId]);
        return 'dropped';
    }

    /** Sets the end once (a second call changes nothing). Throws on a database error. */
    async function close(incidentId, { endedAt = new Date(), endedBy = null } = {}) {
        const { rowCount } = await query(
            `UPDATE ${TL} SET ended_at = $2, ended_by = $3 WHERE id = $1 AND ended_at IS NULL`,
            [incidentId, new Date(endedAt), idOrNull(endedBy)],
        );
        return rowCount === 1;
    }

    async function linkReport(incidentId, reportId) {
        const { rowCount } = await query(`UPDATE ${TL} SET report_id = $2 WHERE id = $1`, [incidentId, reportId]);
        return rowCount === 1;
    }

    /** Deletes incidents that ended (or, never closed, started) more than `days` ago. Returns the count. */
    async function purge(now = Date.now(), days = RETENTION_DAYS) {
        const { rowCount } = await query(
            `DELETE FROM ${TL} WHERE COALESCE(ended_at, started_at) < $1`,
            [new Date(now - days * DAY_MS)],
        );
        return rowCount || 0;
    }

    /** Incidents of a guild, newest first. */
    async function list(guildId, { limit = 100 } = {}) {
        const { rows } = await query(
            `SELECT id, guild_id, trigger_kind, started_at, ended_at, ended_by, report_id, event_count, dropped_events
             FROM ${TL} WHERE guild_id = $1 ORDER BY started_at DESC, id DESC LIMIT $2`,
            [guildId, Math.min(500, Math.max(1, limit))],
        );
        return rows;
    }

    /** One incident of this guild (never another guild's), or null. */
    async function get(guildId, incidentId) {
        if (!/^\d{1,18}$/.test(String(incidentId))) return null;
        const { rows } = await query(
            `SELECT id, guild_id, trigger_kind, started_at, ended_at, ended_by, report_id, event_count, dropped_events
             FROM ${TL} WHERE id = $1 AND guild_id = $2`,
            [String(incidentId), guildId],
        );
        return rows[0] || null;
    }

    async function events(incidentId) {
        const { rows } = await query(
            `SELECT id, at, kind, actor_id, target_id, detail FROM ${EV}
             WHERE incident_id = $1 ORDER BY at, id LIMIT $2`,
            [incidentId, maxEvents],
        );
        return rows;
    }

    /**
     * What existing tables say about the incident window: joins and leaves, cases (not
     * test, not voided), dashboard changes (the Owner area left out) and the report.
     */
    async function sources(guildId, incident, now = Date.now()) {
        const from = new Date(new Date(incident.started_at).getTime() - automodConfig.raidWindowMs);
        const to = incident.ended_at ? new Date(incident.ended_at) : new Date(now);
        const [members, cases, audit, report] = await Promise.all([
            query(
                `SELECT id, user_id, kind, created_at FROM ${tables.member_events}
                 WHERE guild_id = $1 AND created_at >= $2 AND created_at <= $3
                 ORDER BY created_at, id LIMIT $4`,
                [guildId, from, to, MAX_SOURCE_ROWS + 1],
            ),
            query(
                `SELECT id, case_code, type, target_user_id, target_username, moderator_id, moderator_username, is_auto, created_at
                 FROM ${tables.mod_cases}
                 WHERE guild_id = $1 AND created_at >= $2 AND created_at <= $3 AND is_test = FALSE AND voided_at IS NULL
                 ORDER BY created_at, id LIMIT $4`,
                [guildId, new Date(incident.started_at), to, MAX_SOURCE_ROWS + 1],
            ),
            query(
                `SELECT id, user_id, username, module, key, created_at FROM ${tables.dashboard_audit}
                 WHERE guild_id = $1 AND created_at >= $2 AND created_at <= $3 AND module <> ALL(ARRAY['owner', 'website'])
                 ORDER BY created_at, id LIMIT $4`,
                // A minute past the end: "End lockdown" on the dashboard is audited just after it ended.
                [guildId, new Date(incident.started_at), new Date(to.getTime() + MINUTE_MS), MAX_AUDIT_ROWS + 1],
            ),
            incident.report_id
                ? query(
                    `SELECT id, joiner_ids, released_at, released_by FROM ${tables.automod_raid_incidents} WHERE id = $1 AND guild_id = $2`,
                    [incident.report_id, guildId],
                )
                : Promise.resolve({ rows: [] }),
        ]);
        return {
            members: members.rows.slice(0, MAX_SOURCE_ROWS),
            cases: cases.rows.slice(0, MAX_SOURCE_ROWS),
            audit: audit.rows.slice(0, MAX_AUDIT_ROWS),
            report: report.rows[0] || null,
            truncated: {
                members: members.rows.length > MAX_SOURCE_ROWS,
                cases: cases.rows.length > MAX_SOURCE_ROWS,
                audit: audit.rows.length > MAX_AUDIT_ROWS,
            },
        };
    }

    return { open, addEvent, close, linkReport, purge, list, get, events, sources };
}

let store = createTimelineStore();

/** Test hook: replace the default store (no argument restores it). */
export function setTimelineStoreForTest(replacement = null) {
    store = replacement || createTimelineStore();
}

export function timelineStore() {
    return store;
}

// ── Recording: never throws ───────────────────────────────────────────────

/** Opens an incident; resolves its id, or null when it could not be stored (logged). */
export async function openTimeline(fields) {
    try {
        return await store.open(fields);
    } catch (error) {
        logger.warn(`Raid timeline: could not open an incident in ${fields?.guildId}: ${error.message}`);
        return null;
    }
}

/** Records one event; resolves 'stored' | 'dropped' | 'invalid' | 'failed'. */
export async function addTimelineEvent(incidentId, event) {
    if (!incidentId) return 'invalid';
    try {
        return await store.addEvent(incidentId, event);
    } catch (error) {
        logger.warn(`Raid timeline: could not record ${event?.kind} on incident ${incidentId}: ${error.message}`);
        return 'failed';
    }
}

export async function closeTimeline(incidentId, fields) {
    if (!incidentId) return false;
    try {
        return await store.close(incidentId, fields);
    } catch (error) {
        logger.warn(`Raid timeline: could not close incident ${incidentId}: ${error.message}`);
        return false;
    }
}

export async function linkTimelineReport(incidentId, reportId) {
    if (!incidentId || !reportId) return false;
    try {
        return await store.linkReport(incidentId, reportId);
    } catch (error) {
        logger.warn(`Raid timeline: could not link report ${reportId} to incident ${incidentId}: ${error.message}`);
        return false;
    }
}

/** The daily cron: deletes incidents older than RETENTION_DAYS. Throws on a database error. */
export async function purgeIncidentTimelines(now = Date.now()) {
    const count = await store.purge(now);
    if (count) logger.info(`Raid timeline: ${count} incident(s) older than ${RETENTION_DAYS} days deleted`);
    return count;
}

// ── Building the page data (pure) ─────────────────────────────────────────

const CASE_WORD = { ban: 'Ban', kick: 'Kick', mute: 'Mute', warn: 'Warn' };

/** Chart bucket sizes in minutes: the smallest that keeps the chart at most `maxBars` wide. */
const BUCKETS = [1, 2, 5, 10, 15, 30, 60, 120, 240, 480, 720, 1440];
export function bucketMinutes(spanMs, maxBars = 60) {
    const minutes = Math.max(1, Math.ceil(spanMs / MINUTE_MS));
    return BUCKETS.find((size) => Math.ceil(minutes / size) <= maxBars) || Math.ceil(minutes / maxBars);
}

/**
 * Everything the detail page shows, from the incident row, its recorded events and the
 * merged sources. `active`: the running lockdown belongs to this incident.
 */
export function buildTimeline({ incident, events = [], sources = {}, active = false, now = Date.now() }) {
    const joiners = new Set(Array.isArray(sources.report?.joiner_ids) ? sources.report.joiner_ids : []);
    const items = [];
    for (const row of events) {
        if (!EVENT_KINDS[row.kind]) continue;
        items.push({ at: new Date(row.at), kind: row.kind, actorId: row.actor_id || null, targetId: row.target_id || null, detail: row.detail || null, order: 1, id: Number(row.id) || 0 });
    }
    for (const row of sources.members || []) {
        if (row.kind !== 'join' && row.kind !== 'leave') continue;
        items.push({ at: new Date(row.created_at), kind: row.kind, actorId: null, targetId: row.user_id, detail: row.kind === 'join' && joiners.has(row.user_id) ? 'Raid joiner' : null, order: 0, id: Number(row.id) || 0 });
    }
    for (const row of sources.cases || []) {
        const by = row.is_auto ? 'by automod' : `by ${row.moderator_username || row.moderator_id}`;
        items.push({
            at: new Date(row.created_at), kind: 'case', caseType: row.type, code: row.case_code,
            actorId: row.is_auto ? null : row.moderator_id, targetId: row.target_user_id, targetName: row.target_username,
            detail: `${CASE_WORD[row.type] || row.type} ${by}${joiners.has(row.target_user_id) ? ' (raid joiner)' : ''}`, order: 2, id: Number(row.id) || 0,
        });
    }
    for (const row of sources.audit || []) {
        items.push({ at: new Date(row.created_at), kind: 'dashboard', actorId: row.user_id || null, detail: cleanDetail(`${row.module}: ${row.key} by ${row.username || row.user_id || 'someone'}`), order: 3, id: Number(row.id) || 0 });
    }
    items.sort((a, b) => a.at - b.at || a.order - b.order || a.id - b.id);

    const started = new Date(incident.started_at);
    const ended = incident.ended_at ? new Date(incident.ended_at) : null;
    // active: true / false, or null when the lockdown state could not be read.
    const status = ended ? 'ended' : active === null ? 'unread' : active ? 'ongoing' : 'unknown';
    const end = ended || (active ? new Date(now) : (items.length ? items[items.length - 1].at : started));

    const actions = { ban: 0, kick: 0, mute: 0, warn: 0, gate_kick: 0, gate_flag: 0, automod: 0, mass_block: 0 };
    let joins = 0;
    let leaves = 0;
    let verification = null;
    let panic = null;
    for (const item of items) {
        if (item.kind === 'case' && Object.hasOwn(actions, item.caseType)) actions[item.caseType] += 1;
        else if (Object.hasOwn(actions, item.kind)) actions[item.kind] += 1;
        else if (item.kind === 'join') joins += 1;
        else if (item.kind === 'leave') leaves += 1;
        else if (item.kind === 'verification' && verification === null) verification = item.detail;
        else if (item.kind === 'panic' && panic === null) panic = item.detail;
    }

    // Minute by minute: only minutes with something in them; the page shows the quiet gaps.
    const minutes = [];
    for (const item of items) {
        const start = Math.floor(item.at.getTime() / MINUTE_MS) * MINUTE_MS;
        let minute = minutes[minutes.length - 1];
        if (!minute || minute.start !== start) {
            minute = { start, counts: { joins: 0, leaves: 0, actions: 0, steps: 0 }, items: [] };
            minutes.push(minute);
        }
        minute.counts[EVENT_KINDS[item.kind].group] += 1;
        minute.items.push(item);
    }

    // Joins and actions per bucket for the chart.
    const chartStart = Math.floor(Math.min(started.getTime(), items[0]?.at.getTime() ?? Infinity) / MINUTE_MS) * MINUTE_MS;
    const chartEnd = Math.max(end.getTime(), items[items.length - 1]?.at.getTime() ?? 0, chartStart + MINUTE_MS);
    const size = bucketMinutes(chartEnd - chartStart);
    const count = Math.max(1, Math.ceil((chartEnd - chartStart) / (size * MINUTE_MS)));
    const buckets = Array.from({ length: count }, (_, i) => ({ start: chartStart + i * size * MINUTE_MS, joins: 0, actions: 0 }));
    for (const item of items) {
        const index = Math.min(count - 1, Math.max(0, Math.floor((item.at.getTime() - chartStart) / (size * MINUTE_MS))));
        const group = EVENT_KINDS[item.kind].group;
        if (group === 'joins') buckets[index].joins += 1;
        if (group === 'actions') buckets[index].actions += 1;
    }

    return {
        header: {
            id: String(incident.id), trigger: TRIGGERS[incident.trigger_kind] || incident.trigger_kind, started, ended, status,
            durationMs: Math.max(0, end.getTime() - started.getTime()), endedBy: incident.ended_by || null,
            joins, leaves, raidJoiners: sources.report ? joiners.size : null, actions, verification, panic,
            released: sources.report?.released_at ? { at: new Date(sources.report.released_at), by: sources.report.released_by } : null,
            dropped: Number(incident.dropped_events) || 0, truncated: sources.truncated || {},
        },
        minutes,
        chart: { bucketMinutes: size, buckets },
        total: items.length,
    };
}

/** "1 h 5 min", "12 min", "under a minute". */
export function formatSpan(ms) {
    const minutes = Math.floor(ms / MINUTE_MS);
    if (minutes < 1) return 'under a minute';
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const rest = minutes % 60;
    return [days ? `${days} d` : null, hours ? `${hours} h` : null, rest ? `${rest} min` : null].filter(Boolean).join(' ');
}
