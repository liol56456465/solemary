// weeklyDigest.js: a short summary of the server's week, posted to the mod log on Monday
// morning with the weekly staff and automod reports. Joins and leaves, messages and the
// busiest day, cases by type, appeals filed and decided. Real counts only; a part that cannot
// be read is said to be unavailable rather than left at 0.

import { enforcementConfig } from '../../config/enforcement.js';
import { pgConfig } from '../../config/database/postgres.js';
import { query as defaultQuery, isEnforcementDbAvailable } from '../enforcement/db.js';
import { postModLog } from '../enforcement/enforcementService.js';
import { activitySeries } from './activityService.js';
import { logger } from '../../utils/logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** The numbers for the last 7 days. Each part is null when it could not be read. */
export async function digestData(guildId, { now = Date.now(), query = defaultQuery, series = activitySeries } = {}) {
    const since = new Date(now - 7 * DAY_MS);
    const t = pgConfig.tables;
    const part = async (fn) => { try { return await fn(); } catch (error) { logger.warn(`Weekly digest: ${error.message}`); return null; } };
    const days = await part(() => series(guildId, { days: 7, now, query }));
    const cases = await part(async () => (await query(
        `SELECT type, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE is_auto)::int AS auto FROM ${t.mod_cases}
         WHERE guild_id = $1 AND created_at >= $2 AND is_test IS NOT TRUE AND is_imported IS NOT TRUE GROUP BY type`, [guildId, since])).rows);
    const appeals = await part(async () => (await query(
        `SELECT COUNT(*) FILTER (WHERE created_at >= $2)::int AS filed,
                COUNT(*) FILTER (WHERE decided_at >= $2 AND status = 'accepted')::int AS accepted,
                COUNT(*) FILTER (WHERE decided_at >= $2 AND status = 'denied')::int AS denied,
                COUNT(*) FILTER (WHERE status = 'pending')::int AS open
         FROM ${t.mod_appeals} WHERE guild_id = $1 AND kind = 'appeal'`, [guildId, since])).rows[0]);
    return { days, cases, appeals };
}

/** The digest as embed fields. Pure, for tests. */
export function digestFields({ days, cases, appeals }) {
    const unavailable = 'unavailable (database)';
    const fields = [];
    if (days) {
        const joins = days.reduce((s, d) => s + d.joins, 0);
        const leaves = days.reduce((s, d) => s + d.leaves, 0);
        const messages = days.reduce((s, d) => s + d.messages, 0);
        const busiest = days.reduce((best, d) => (d.messages > best.messages ? d : best), days[0]);
        fields.push({ name: 'Members', value: `${joins} joined, ${leaves} left (${joins - leaves >= 0 ? '+' : ''}${joins - leaves})` });
        fields.push({ name: 'Messages', value: messages ? `${messages}. Busiest day: ${WEEKDAY.format(new Date(`${busiest.day}T00:00:00Z`))} (${busiest.messages})` : 'none counted' });
    } else {
        fields.push({ name: 'Members and messages', value: unavailable });
    }
    if (cases) {
        const by = Object.fromEntries(cases.map((r) => [r.type, r.n]));
        const total = cases.reduce((s, r) => s + r.n, 0);
        const auto = cases.reduce((s, r) => s + r.auto, 0);
        fields.push({ name: 'Cases', value: total ? `${total}: ${by.ban || 0} bans, ${by.kick || 0} kicks, ${by.mute || 0} mutes, ${by.warn || 0} warns (${auto} automatic)` : 'none' });
    } else {
        fields.push({ name: 'Cases', value: unavailable });
    }
    fields.push({
        name: 'Appeals',
        value: appeals ? `${appeals.filed} filed, ${appeals.accepted} accepted, ${appeals.denied} denied. ${appeals.open} still open.` : unavailable,
    });
    return fields;
}

/** Monday morning, with the other weekly reports. Never throws. */
export async function postWeeklyDigest(client, { post = postModLog } = {}) {
    try {
        if (!isEnforcementDbAvailable() || !client.guilds.cache.has(enforcementConfig.mainGuildId)) return false;
        const data = await digestData(enforcementConfig.mainGuildId);
        await post(client, 'server-digest', digestFields(data), { guildId: enforcementConfig.mainGuildId, title: 'This week in the server' });
        return true;
    } catch (error) {
        logger.error(`Weekly digest: ${error.message}`);
        return false;
    }
}
