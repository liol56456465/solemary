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

// Staff with fewer messages than this and no moderation work in a week are flagged.
const INACTIVE_MESSAGE_THRESHOLD = 20;

const pendingMessages = new Map(); // guildId:userId → count

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

/** Counts a message from a staff member in the main server (cheap: buffered). */
export function noteStaffMessage(message) {
    if (message.guildId !== enforcementConfig.mainGuildId || !isStaff(message.member)) return;
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
            `SELECT decided_by AS user_id, COUNT(*)::int AS count FROM ${T.appeals}
             WHERE decided_at >= $1 AND decided_at < $2 AND decided_by IS NOT NULL GROUP BY decided_by`,
            [`${start}T00:00:00Z`, end.toISOString()]
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

export function formatActivityLine(row) {
    return `${row.inactive ? '⚠️ ' : ''}**${row.username}** — ${row.messages} msgs · ${row.actions} actions · ${row.appeals} appeals · ${row.reviews} reviews · ${row.tickets} tickets`;
}

/** Posts last week's staff activity in the mod log and DMs the owner who was inactive. */
export async function postWeeklyStaffReport(client) {
    const guild = client.guilds.cache.get(enforcementConfig.mainGuildId);
    if (!guild || !isEnforcementDbAvailable()) return;
    await guild.members.fetch().catch(() => null);

    const lastWeek = new Date();
    lastWeek.setUTCDate(lastWeek.getUTCDate() - 7);
    const start = weekStart(lastWeek);
    const rows = await staffActivityForWeek(guild, start);
    if (!rows.length) return;

    const inactive = rows.filter((row) => row.inactive);
    const lines = rows.map(formatActivityLine);
    await postModLog(client, 'staff', [
        { name: `Week of ${start}`, value: lines.join('\n').slice(0, 1024) || 'No staff' },
        { name: 'Inactive', value: inactive.length ? inactive.map((row) => `<@${row.userId}>`).join(', ') : 'Nobody', inline: false },
    ], { title: 'Weekly staff activity' });

    if (inactive.length) {
        const owner = await guild.fetchOwner().catch(() => null);
        await owner?.send({
            content: [
                `**Staff activity, week of ${start}:** ${inactive.length} staff member(s) did no moderation work and sent under ${INACTIVE_MESSAGE_THRESHOLD} messages:`,
                ...inactive.map((row) => `• ${row.username} (\`${row.userId}\`)`),
                'Admin rule 8: stay active. Use `/staff warn` if needed.',
            ].join('\n'),
            allowedMentions: { parse: [] },
        }).catch(() => {});
    }
}
