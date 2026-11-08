// staffActivityService.js — what each staff member did this week, for the weekly
// report and /staff activity (admin rule 8: stay active and help moderate).
//
// Messages, review-card decisions and claimed tickets are counted into
// staff_activity (messages are buffered in memory and written once a minute).
// Moderation actions and appeal decisions come from mod_cases / mod_appeals.

import { enforcementConfig } from '../config/enforcement.js';
import { logger } from '../utils/logger.js';
import { query, T, isEnforcementDbAvailable } from './enforcement/db.js';
import { postModLog } from './enforcement/enforcementService.js';
import { isStaff } from './automod/automodService.js';
import { isMewvoServer } from '../utils/ownerPower.js';
import { BoundedMap } from '../utils/boundedMap.js';
import { resolveChannelId, staffGuildId } from './automod/channelRouting.js';
import { isSettingsUnavailable, noteSettingsUnavailable } from './settings/guildScoped.js';

// Staff with fewer messages than this and no moderation work in a week are flagged.
const INACTIVE_MESSAGE_THRESHOLD = 20;

// Buffered message counts, written once a minute (one upsert per staff member per minute).
// Bounded: the bot is public; a dropped entry only loses a minute of one member's count.
export const PENDING_MESSAGES_MAX = 20000;
const pendingMessages = new BoundedMap(PENDING_MESSAGES_MAX); // guildId:userId → count
// At most this many servers get a weekly staff report per run.
export const WEEKLY_REPORT_GUILDS_MAX = 5000;

/** Test hooks. */
export function pendingStaffMessages() {
    return new Map(pendingMessages);
}
export function resetStaffActivityState() {
    pendingMessages.clear();
}

/** Monday 00:00 UTC of the week containing `date`, as YYYY-MM-DD. */
export function weekStart(date = new Date()) {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
}

async function bump(guildId, userId, field, amount = 1) {
    if (!isEnforcementDbAvailable()) return;
    await query(
        `INSERT INTO ${T.staffActivity} (guild_id, user_id, week_start, ${field}) VALUES ($1, $2, $3, $4)
         ON CONFLICT (guild_id, user_id, week_start) DO UPDATE SET ${field} = ${T.staffActivity}.${field} + EXCLUDED.${field}`,
        [guildId, userId, weekStart(), amount]
    );
}

/**
 * Counts a message from a staff member, per server (cheap: buffered in memory, flushed once a
 * minute). Every server (multi-server B4): each server gets its own weekly staff report and
 * /staff activity.
 */
export function noteStaffMessage(message) {
    if (!message.guildId || !isStaff(message.member)) return;
    const key = `${message.guildId}:${message.author.id}`;
    pendingMessages.set(key, (pendingMessages.get(key) || 0) + 1);
}

/** Writes the buffered message counts; run every minute. */
export async function flushStaffMessages() {
    const entries = [...pendingMessages];
    pendingMessages.clear();
    for (const [key, count] of entries) {
        const [guildId, userId] = key.split(':');
        await bump(guildId, userId, 'messages', count).catch((error) => logger.warn(`Staff activity flush failed: ${error.message}`));
    }
}

/** A review card, verification approval or similar staff decision. */
export function noteStaffReview(guildId, userId) {
    return bump(guildId, userId, 'reviews').catch((error) => logger.warn(`Staff activity (review) failed: ${error.message}`));
}

export function noteTicketClaim(guildId, userId) {
    return bump(guildId, userId, 'tickets').catch((error) => logger.warn(`Staff activity (ticket) failed: ${error.message}`));
}

/**
 * One row per current staff member for the week starting `start` (YYYY-MM-DD):
 * { userId, username, messages, actions, appeals, reviews, tickets, inactive }.
 */
export async function staffActivityForWeek(guild, start) {
    const end = new Date(`${start}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 7);
    const [counters, actions, appeals] = await Promise.all([
        query(`SELECT user_id, messages, reviews, tickets FROM ${T.staffActivity} WHERE guild_id = $1 AND week_start = $2`, [guild.id, start]),
        query(
            `SELECT moderator_id AS user_id, COUNT(*)::int AS count FROM ${T.cases}
             WHERE guild_id = $1 AND created_at >= $2 AND created_at < $3 AND is_test = FALSE AND voided_at IS NULL AND moderator_id <> $4
             GROUP BY moderator_id`,
            [guild.id, `${start}T00:00:00Z`, end.toISOString(), guild.client.user.id]
        ),
        query(
            // This server's decisions only (an appeal row's guild_id is the server that decides it).
            `SELECT decided_by AS user_id, COUNT(*)::int AS count FROM ${T.appeals}
             WHERE guild_id = $3 AND decided_at >= $1 AND decided_at < $2 AND decided_by IS NOT NULL GROUP BY decided_by`,
            [`${start}T00:00:00Z`, end.toISOString(), guild.id]
        ),
    ]);
    const byUser = (rows) => new Map(rows.map((row) => [row.user_id, row]));
    const counterMap = byUser(counters.rows);
    const actionMap = byUser(actions.rows);
    const appealMap = byUser(appeals.rows);

    const staff = [...guild.members.cache.values()].filter((member) => !member.user.bot && isStaff(member));
    return staff.map((member) => {
        const c = counterMap.get(member.id) || {};
        const row = {
            userId: member.id,
            username: member.user.username,
            isOwner: member.id === guild.ownerId,
            messages: c.messages || 0,
            reviews: c.reviews || 0,
            tickets: c.tickets || 0,
            actions: actionMap.get(member.id)?.count || 0,
            appeals: appealMap.get(member.id)?.count || 0,
        };
        row.inactive = !row.isOwner && row.actions + row.appeals + row.reviews + row.tickets === 0 && row.messages < INACTIVE_MESSAGE_THRESHOLD;
        return row;
    }).sort((a, b) => (b.actions + b.reviews + b.tickets + b.appeals) - (a.actions + a.reviews + a.tickets + a.appeals) || b.messages - a.messages);
}

export const STATS_PERIODS = {
    '7d': { label: 'last 7 days', days: 7 },
    '30d': { label: 'last 30 days', days: 30 },
    '90d': { label: 'last 90 days', days: 90 },
    all: { label: 'all time', days: null },
};

/**
 * Moderation stats per moderator from mod_cases, for /staff stats. Test cases and
 * the bot's own (automatic) cases are left out; voided cases are counted apart and
 * not in the action totals. Appeals are those decided in the period on cases the
 * moderator gave. Returns rows sorted by actions:
 * { moderatorId, username, actions: { ban, kick, mute, warn }, total, voided, appealsAccepted, appealsDenied }.
 */
export async function staffModerationStats(guildId, botUserId, { period = '30d', moderatorId = null } = {}) {
    const days = STATS_PERIODS[period]?.days ?? null;
    const since = days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : null;
    const [cases, appeals] = await Promise.all([
        query(
            `SELECT moderator_id, MAX(moderator_username) AS username, type,
                    COUNT(*) FILTER (WHERE voided_at IS NULL)::int AS count,
                    COUNT(*) FILTER (WHERE voided_at IS NOT NULL)::int AS voided
             FROM ${T.cases}
             WHERE guild_id = $1 AND is_test = FALSE AND moderator_id <> $2
               AND ($3::timestamptz IS NULL OR created_at >= $3)
               AND ($4::varchar IS NULL OR moderator_id = $4)
             GROUP BY moderator_id, type`,
            [guildId, botUserId, since, moderatorId]
        ),
        query(
            `SELECT c.moderator_id, MAX(c.moderator_username) AS username,
                    COUNT(*) FILTER (WHERE a.status = 'accepted')::int AS accepted,
                    COUNT(*) FILTER (WHERE a.status = 'denied')::int AS denied
             FROM ${T.appeals} a JOIN ${T.cases} c ON c.case_code = a.case_code
             WHERE a.kind = 'appeal' AND a.status IN ('accepted', 'denied')
               AND c.guild_id = $1 AND c.is_test = FALSE AND c.moderator_id <> $2
               AND ($3::timestamptz IS NULL OR a.decided_at >= $3)
               AND ($4::varchar IS NULL OR c.moderator_id = $4)
             GROUP BY c.moderator_id`,
            [guildId, botUserId, since, moderatorId]
        ),
    ]);

    const byMod = new Map();
    const entry = (id, username) => {
        if (!byMod.has(id)) {
            byMod.set(id, {
                moderatorId: id, username, actions: { ban: 0, kick: 0, mute: 0, warn: 0 },
                total: 0, voided: 0, appealsAccepted: 0, appealsDenied: 0,
            });
        }
        return byMod.get(id);
    };
    for (const row of cases.rows) {
        const e = entry(row.moderator_id, row.username);
        e.actions[row.type] = (e.actions[row.type] || 0) + row.count;
        e.total += row.count;
        e.voided += row.voided;
    }
    for (const row of appeals.rows) {
        const e = entry(row.moderator_id, row.username);
        e.appealsAccepted = row.accepted;
        e.appealsDenied = row.denied;
    }
    return [...byMod.values()].sort((a, b) => b.total - a.total || a.username.localeCompare(b.username));
}

export function formatStatsLine(row) {
    const { ban, kick, mute, warn } = row.actions;
    return `**${row.username}**: ${row.total} actions (${ban} bans · ${kick} kicks · ${mute} mutes · ${warn} warns)`
        + ` · appeals on their cases: ${row.appealsAccepted} accepted / ${row.appealsDenied} denied`
        + (row.voided ? ` · ${row.voided} removed` : '');
}

export function formatActivityLine(row) {
    return `**${row.username}**${row.inactive ? ' (inactive)' : ''}: ${row.messages} msgs · ${row.actions} actions · ${row.appeals} appeals · ${row.reviews} reviews · ${row.tickets} tickets`;
}

/**
 * Servers with any staff activity in the week starting `start` (YYYY-MM-DD): counted messages,
 * reviews or tickets, cases made by a human moderator, or appeal decisions. Throws on a DB error.
 */
export async function guildsWithStaffActivity(start, botUserId) {
    const end = new Date(`${start}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 7);
    const { rows } = await query(
        `SELECT guild_id FROM ${T.staffActivity} WHERE week_start = $1
         UNION SELECT guild_id FROM ${T.cases}
               WHERE created_at >= $2 AND created_at < $3 AND is_test = FALSE AND voided_at IS NULL AND moderator_id <> $4
         UNION SELECT guild_id FROM ${T.appeals}
               WHERE decided_at >= $2 AND decided_at < $3 AND decided_by IS NOT NULL
         LIMIT ${WEEKLY_REPORT_GUILDS_MAX}`,
        [start, `${start}T00:00:00Z`, end.toISOString(), botUserId]
    );
    return rows.map((row) => String(row.guild_id));
}

/**
 * The servers that get a weekly staff report: the main server (as before) plus `candidates`.
 * Home servers count as one staff: the support server maps to the main server (one report, as
 * before). Only servers the bot is in, and only where a staff channel for it is set (alerts, or
 * the mod log it falls back to). A server whose settings can't be read is skipped this run.
 * `channelFor` is injectable for tests.
 */
export function weeklyReportGuilds(client, candidates = [], { channelFor = (guildId) => resolveChannelId(guildId, 'alerts') } = {}) {
    const out = [];
    const seen = new Set();
    for (const id of [enforcementConfig.mainGuildId, ...candidates]) {
        if (!id) continue;
        const guildId = staffGuildId(String(id));
        if (seen.has(guildId) || !client.guilds.cache.has(guildId)) continue;
        seen.add(guildId);
        let channelId = null;
        try {
            channelId = channelFor(guildId);
        } catch (error) {
            if (!isSettingsUnavailable(error)) throw error;
            noteSettingsUnavailable(guildId, 'weekly staff report');
        }
        if (!channelId) continue;
        out.push(guildId);
        if (out.length >= WEEKLY_REPORT_GUILDS_MAX) break;
    }
    return out;
}

/** Posts last week's staff activity in each server's own staff channel and DMs its owner who was inactive. */
export async function postWeeklyStaffReport(client) {
    if (!isEnforcementDbAvailable()) return;
    const lastWeek = new Date();
    lastWeek.setUTCDate(lastWeek.getUTCDate() - 7);
    const start = weekStart(lastWeek);
    const candidates = await guildsWithStaffActivity(start, client.user?.id || '0');
    for (const guildId of weeklyReportGuilds(client, candidates)) {
        try {
            await postWeeklyStaffReportFor(client, client.guilds.cache.get(guildId), start);
        } catch (error) {
            logger.warn(`Weekly staff report for ${guildId} failed: ${error.message}`);
        }
    }
}

/** One server's weekly staff report (week starting `start`), in that server's staff channel. */
export async function postWeeklyStaffReportFor(client, guild, start) {
    if (!guild) return;
    await guild.members.fetch().catch(() => null);
    const rows = await staffActivityForWeek(guild, start);
    if (!rows.length) return;

    const inactive = rows.filter((row) => row.inactive);
    const lines = rows.map(formatActivityLine);
    await postModLog(client, 'staff', [
        { name: `Week of ${start}`, value: lines.join('\n').slice(0, 1024) || 'No staff' },
        { name: 'Inactive', value: inactive.length ? inactive.map((row) => `<@${row.userId}>`).join(', ').slice(0, 1024) : 'Nobody', inline: false },
    ], { guildId: guild.id, title: 'Weekly staff activity' });

    if (inactive.length) {
        const owner = await guild.fetchOwner().catch(() => null);
        const shown = inactive.slice(0, 50);
        await owner?.send({
            content: [
                `**Staff activity in ${guild.name}, week of ${start}:** ${inactive.length} staff member(s) did no moderation work and sent under ${INACTIVE_MESSAGE_THRESHOLD} messages:`,
                ...shown.map((row) => `• ${row.username} (\`${row.userId}\`)`),
                inactive.length > shown.length ? `…and ${inactive.length - shown.length} more.` : null,
                isMewvoServer(guild.id) ? 'Admin rule 8: stay active. Use `/staff warn` if needed.' : 'Use `/staff warn` if needed.',
            ].filter(Boolean).join('\n').slice(0, 2000),
            allowedMentions: { parse: [] },
        }).catch(() => {});
    }
}
