// reminderService.js: /remind. Reminders live in the database (table reminders), so they
// survive restarts. A cron once a minute sends what is due: by DM, or in the channel the
// reminder was made in when the DM fails. Each reminder is claimed with FOR UPDATE SKIP
// LOCKED and marked sent before it goes out, so two processes never send it twice (a crash
// in between loses that one reminder rather than repeating it).

import { pgConfig } from '../../config/database/postgres.js';
import { query as defaultQuery } from '../enforcement/db.js';
import { parseDuration } from '../enforcement/format.js';
import { logger } from '../../utils/logger.js';

export const REMINDER_TEXT_MAX = 500;
export const MAX_ACTIVE_REMINDERS = 25;
export const MAX_REMINDER_MS = 365 * 24 * 60 * 60 * 1000;
export const MIN_REMINDER_MS = 60 * 1000;
const BATCH = 50;

export class ReminderError extends Error {
    constructor(message) { super(message); this.userMessage = message; }
}

/** "2h", "1d 12h", "30m" → ms, or a ReminderError with a readable message. */
export function reminderDelay(input) {
    const ms = parseDuration(input);
    if (ms === null) throw new ReminderError('I could not read that time. Use something like `10m`, `2h`, `1d` or `1d12h`.');
    if (ms < MIN_REMINDER_MS) throw new ReminderError('The shortest reminder is 1 minute.');
    if (ms > MAX_REMINDER_MS) throw new ReminderError('The longest reminder is 1 year.');
    return ms;
}

export function cleanReminderText(text) {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) throw new ReminderError('Write what you want to be reminded about.');
    if (clean.length > REMINDER_TEXT_MAX) throw new ReminderError(`Keep it under ${REMINDER_TEXT_MAX} characters.`);
    return clean;
}

export function createReminderStore({ query = defaultQuery, table = pgConfig.tables.reminders, now = () => Date.now() } = {}) {
    return {
        async create({ userId, guildId = null, channelId = null, text, delayMs }) {
            const clean = cleanReminderText(text);
            const { rows: [{ count }] } = await query(`SELECT COUNT(*)::int AS count FROM ${table} WHERE user_id = $1 AND sent_at IS NULL`, [userId]);
            if (count >= MAX_ACTIVE_REMINDERS) throw new ReminderError(`You already have ${MAX_ACTIVE_REMINDERS} reminders. Delete one with \`/remind delete\` first.`);
            const dueAt = new Date(now() + delayMs);
            const { rows: [row] } = await query(
                `INSERT INTO ${table} (user_id, guild_id, channel_id, text, due_at) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                [userId, guildId, channelId, clean, dueAt],
            );
            return row;
        },
        async listActive(userId) {
            const { rows } = await query(`SELECT * FROM ${table} WHERE user_id = $1 AND sent_at IS NULL ORDER BY due_at LIMIT ${MAX_ACTIVE_REMINDERS}`, [userId]);
            return rows;
        },
        /** Deletes one of the user's own unsent reminders; null when there is none with that id. */
        async remove(userId, id) {
            if (!/^\d{1,18}$/.test(String(id))) return null;
            const { rows: [row] } = await query(`DELETE FROM ${table} WHERE id = $1 AND user_id = $2 AND sent_at IS NULL RETURNING *`, [id, userId]);
            return row || null;
        },
        /** Claims due reminders: marks them sent and returns them (the caller delivers). */
        async claimDue(limit = BATCH) {
            const { rows } = await query(
                `UPDATE ${table} SET sent_at = NOW() WHERE id IN (
                    SELECT id FROM ${table} WHERE sent_at IS NULL AND due_at <= $1 ORDER BY due_at LIMIT ${Number(limit)} FOR UPDATE SKIP LOCKED
                 ) RETURNING *`,
                [new Date(now())],
            );
            return rows;
        },
        async markFailed(id) {
            await query(`UPDATE ${table} SET failed_at = NOW() WHERE id = $1`, [id]);
        },
        /** Sent reminders are deleted after 30 days. */
        async prune() {
            const { rowCount } = await query(`DELETE FROM ${table} WHERE sent_at IS NOT NULL AND sent_at < $1`, [new Date(now() - 30 * 24 * 3600 * 1000)]);
            return rowCount || 0;
        },
    };
}

export const reminderStore = createReminderStore();

const ts = (date, style) => `<t:${Math.floor(new Date(date).getTime() / 1000)}:${style}>`;

/** The message a reminder sends. */
export function reminderMessage(row) {
    return `Reminder from ${ts(row.created_at, 'R')}: ${row.text}`;
}

/**
 * The channel fallback only posts where the member could post the same text themselves right
 * now: same server as when it was made, still a member, not timed out, and able to see and
 * write in that channel (a mute or a ban removes that). Otherwise the reminder fails.
 */
export async function mayPostIn(channel, row) {
    if (!channel?.isTextBased?.() || !channel.guild || !row.guild_id || channel.guild.id !== row.guild_id) return false;
    const member = await channel.guild.members.fetch(row.user_id).catch(() => null);
    if (!member || member.isCommunicationDisabled?.()) return false;
    const perms = channel.permissionsFor?.(member);
    return Boolean(perms?.has?.(['ViewChannel', 'SendMessages']));
}

/** Sends one reminder: DM first, then the channel it was made in. Returns 'dm' | 'channel' | 'failed'. */
export async function deliverReminder(client, row) {
    const content = reminderMessage(row);
    try {
        const user = await client.users.fetch(row.user_id);
        await user.send({ content, allowedMentions: { parse: [] } });
        return 'dm';
    } catch {
        // DMs closed: fall back to the channel, mentioning only that user.
    }
    try {
        const channel = row.channel_id ? await client.channels.fetch(row.channel_id) : null;
        if (await mayPostIn(channel, row) && typeof channel.send === 'function') {
            await channel.send({ content: `<@${row.user_id}> ${content}`, allowedMentions: { users: [row.user_id] } });
            return 'channel';
        }
    } catch {
        // fall through
    }
    return 'failed';
}

/** The cron: send everything that is due. Never throws. */
export async function runReminders(client, store = reminderStore) {
    try {
        const due = await store.claimDue();
        for (const row of due) {
            const how = await deliverReminder(client, row);
            if (how === 'failed') {
                logger.warn(`Reminder ${row.id} for ${row.user_id} could not be delivered (DMs closed, no usable channel)`);
                await store.markFailed(row.id).catch(() => {});
            }
        }
        return due.length;
    } catch (error) {
        logger.error(`Reminders: ${error.message}`);
        return 0;
    }
}
