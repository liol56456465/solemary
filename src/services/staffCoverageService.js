// staffCoverageService.js — /staff coverage: when incidents happen versus when
// staff are active, as weekday × hour text grids (░▒▓█), in the server's
// birthdayTimezone (UTC when unset).
//
// staff_activity only has weekly counters, so it can't say at what hour staff
// were active. Staff activity is therefore approximated by the timestamps of the
// cases human moderators created plus the appeals staff decided. Incidents are all
// cases created, automatic ones included (test and imported cases left out).

import { query, T } from './enforcement/db.js';

export const COVERAGE_PERIODS = { '7d': 7, '30d': 30 };
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SHADES = ['░', '▒', '▓', '█'];
const EMPTY = '·';

/** Hourly counts (UTC hour start → count) for incidents and staff activity. */
export async function loadCoverageCounts(guildId, botUserId, days) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const [incidents, staffCases, appeals] = await Promise.all([
        query(
            `SELECT date_trunc('hour', created_at) AS hour, COUNT(*)::int AS count FROM ${T.cases}
             WHERE guild_id = $1 AND created_at >= $2 AND is_test = FALSE AND is_imported = FALSE
             GROUP BY 1`,
            [guildId, since]
        ),
        query(
            `SELECT date_trunc('hour', created_at) AS hour, COUNT(*)::int AS count FROM ${T.cases}
             WHERE guild_id = $1 AND created_at >= $2 AND is_test = FALSE AND is_imported = FALSE
               AND is_auto = FALSE AND moderator_id <> $3
             GROUP BY 1`,
            [guildId, since, botUserId]
        ),
        query(
            `SELECT date_trunc('hour', a.decided_at) AS hour, COUNT(*)::int AS count
             FROM ${T.appeals} a JOIN ${T.cases} c ON c.case_code = a.case_code
             WHERE c.guild_id = $1 AND a.decided_at >= $2 AND a.decided_by IS NOT NULL AND a.decided_by <> $3
             GROUP BY 1`,
            [guildId, since, botUserId]
        ),
    ]);
    return {
        incidents: incidents.rows,
        staff: [...staffCases.rows, ...appeals.rows],
    };
}

/** A valid IANA time zone, or 'UTC'. */
export function safeTimeZone(timeZone) {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timeZone || 'UTC' });
        return timeZone || 'UTC';
    } catch {
        return 'UTC';
    }
}

/** 7×24 grid (Mon-first) of counts from [{ hour, count }] rows, in a time zone; pure. */
export function bucketByWeekdayHour(rows, timeZone = 'UTC') {
    const grid = WEEKDAYS.map(() => new Array(24).fill(0));
    const format = new Intl.DateTimeFormat('en-US', { timeZone: safeTimeZone(timeZone), weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
    for (const row of rows) {
        const parts = Object.fromEntries(format.formatToParts(new Date(row.hour)).map((part) => [part.type, part.value]));
        const day = WEEKDAYS.indexOf(parts.weekday);
        const hour = Number(parts.hour) % 24;
        if (day >= 0 && hour >= 0) grid[day][hour] += Number(row.count) || 0;
    }
    return grid;
}

/** One shade character for a count relative to the grid's maximum. */
export function shade(count, max) {
    if (!count || !max) return EMPTY;
    return SHADES[Math.min(SHADES.length - 1, Math.ceil((count / max) * SHADES.length) - 1)];
}

/** 0 (none) … 4 (busiest quarter) for a count relative to the maximum: the same steps as shade(). */
export function intensityLevel(count, max) {
    if (!count || !max) return 0;
    return Math.min(SHADES.length, Math.ceil((count / max) * SHADES.length));
}

/** The grid as monospace text: an hour ruler and one row per weekday; pure. */
export function renderGrid(grid) {
    const max = Math.max(0, ...grid.flat());
    const ruler = '    0     6     12    18';
    const rows = grid.map((hours, day) => `${WEEKDAYS[day]} ${hours.map((count) => shade(count, max)).join('')}`);
    return [ruler, ...rows].join('\n');
}

/**
 * The slots with incidents but the least staff activity: ranked by incidents per
 * staff action (+1), then by incidents. [{ day, hour, incidents, staff }].
 */
export function underCoveredSlots(incidentGrid, staffGrid, limit = 3) {
    const slots = [];
    for (let day = 0; day < 7; day += 1) {
        for (let hour = 0; hour < 24; hour += 1) {
            const incidents = incidentGrid[day][hour];
            if (incidents > 0) slots.push({ day, hour, incidents, staff: staffGrid[day][hour] });
        }
    }
    return slots
        .sort((a, b) => (b.incidents / (b.staff + 1)) - (a.incidents / (a.staff + 1)) || b.incidents - a.incidents || a.day - b.day || a.hour - b.hour)
        .slice(0, limit);
}

const pad = (n) => String(n).padStart(2, '0');

export function slotLabel(slot) {
    return `${WEEKDAYS[slot.day]} ${pad(slot.hour)}:00–${pad((slot.hour + 1) % 24)}:00`;
}

/** Everything /staff coverage shows; `counts` from loadCoverageCounts. Pure. */
export function buildCoverageReport(counts, timeZone) {
    const zone = safeTimeZone(timeZone);
    const incidentGrid = bucketByWeekdayHour(counts.incidents, zone);
    const staffGrid = bucketByWeekdayHour(counts.staff, zone);
    const totalIncidents = incidentGrid.flat().reduce((a, b) => a + b, 0);
    const totalStaff = staffGrid.flat().reduce((a, b) => a + b, 0);
    return {
        timeZone: zone,
        totalIncidents,
        totalStaff,
        incidentText: renderGrid(incidentGrid),
        staffText: renderGrid(staffGrid),
        maxIncidents: Math.max(0, ...incidentGrid.flat()),
        maxStaff: Math.max(0, ...staffGrid.flat()),
        gaps: underCoveredSlots(incidentGrid, staffGrid),
        // The grids themselves (7 × 24, Mon-first) for the dashboard's HTML heatmap.
        incidentGrid,
        staffGrid,
    };
}
