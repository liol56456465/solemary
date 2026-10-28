// suggestionService.js — member suggestions (/suggest new | status).
//
// /suggest new posts an embed in the configured suggestions channel with 👍/👎
// buttons. Each member has one vote per suggestion and may change or withdraw
// it (clicking the same button again removes it); the counts on the embed are
// recounted from suggestion_votes inside a transaction that locks the
// suggestion row. Admins set a status (approved, denied, considering) with a
// reason: the embed is updated, voting closes for approved/denied, and the
// author is DMed.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { createEmbed } from '../../utils/embeds.js';
import { CT, query, withTransaction, userError } from './db.js';
import { getCommunitySettings } from './settingsService.js';

export const SUGGESTION_MAX_LENGTH = 1500;
export const SUGGESTION_REASON_MAX = 500;
export const SUGGESTION_COOLDOWN_MS = 2 * 60 * 1000;
export const SUGGESTION_STATUSES = ['approved', 'denied', 'considering'];
export const VOTE_BUTTON_ID = 'suggest_vote';

const STATUS_LABEL = { pending: 'Open for votes', approved: 'Approved', denied: 'Denied', considering: 'Under consideration' };
const STATUS_COLOR = { pending: 'primary', approved: 'success', denied: 'error', considering: 'warning' };
const lastSuggested = new Map(); // guildId:userId → ms

export function isVotingOpen(status) {
    return status === 'pending' || status === 'considering';
}

/** Vote after a click: same button again withdraws (0), otherwise the clicked one; pure. */
export function nextVote(current, clicked) {
    return current === clicked ? 0 : clicked;
}

/** The suggestion message (embed + buttons) for a row; pure. */
export function buildSuggestionMessage(row, author = null) {
    const fields = [
        { name: 'Votes', value: `👍 ${row.upvotes}  ·  👎 ${row.downvotes}`, inline: true },
        { name: 'Status', value: STATUS_LABEL[row.status] || row.status, inline: true },
    ];
    if (row.status !== 'pending' && row.status_reason) {
        fields.push({ name: row.decided_by ? 'Reason (staff)' : 'Reason', value: row.status_reason });
    }
    const embed = createEmbed({
        title: `Suggestion #${row.id}`,
        description: row.content,
        color: STATUS_COLOR[row.status] || 'primary',
        fields,
        author: author
            ? { name: author.username, ...(author.displayAvatarURL ? { iconURL: author.displayAvatarURL() } : {}) }
            : { name: `Member ${row.user_id}` },
        footer: { text: 'Suggest something with /suggest new' },
        timestamp: row.created_at ? new Date(row.created_at) : true,
    });
    const open = isVotingOpen(row.status);
    const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${VOTE_BUTTON_ID}:${row.id}:up`).setEmoji('👍').setLabel(String(row.upvotes)).setStyle(ButtonStyle.Success).setDisabled(!open),
        new ButtonBuilder().setCustomId(`${VOTE_BUTTON_ID}:${row.id}:down`).setEmoji('👎').setLabel(String(row.downvotes)).setStyle(ButtonStyle.Danger).setDisabled(!open),
    );
    return { embeds: [embed], components: [buttons], allowedMentions: { parse: [] } };
}

/** Per-member cooldown for new suggestions; returns ms left (0 when allowed) and records the attempt when allowed. */
export function takeSuggestionSlot(guildId, userId, now = Date.now()) {
    const key = `${guildId}:${userId}`;
    const last = lastSuggested.get(key);
    const left = last === undefined ? 0 : last + SUGGESTION_COOLDOWN_MS - now;
    if (left > 0) return left;
    lastSuggested.set(key, now);
    if (lastSuggested.size > 5000) lastSuggested.delete(lastSuggested.keys().next().value);
    return 0;
}

/** Posts a suggestion; returns { row, message }. */
export async function createSuggestion({ guild, user, content }) {
    const text = String(content ?? '').trim();
    if (!text) throw userError('The suggestion cannot be empty.');
    if (text.length > SUGGESTION_MAX_LENGTH) throw userError(`Suggestions are limited to ${SUGGESTION_MAX_LENGTH} characters.`);
    const { suggestionsChannelId } = getCommunitySettings(guild.id);
    const channel = suggestionsChannelId ? guild.channels.cache.get(suggestionsChannelId) : null;
    if (!channel) throw userError('Suggestions are not set up in this server yet (an admin can use `/community suggestions channel`).');
    const left = takeSuggestionSlot(guild.id, user.id);
    if (left > 0) throw userError(`You can post another suggestion in ${Math.ceil(left / 1000)} seconds.`);

    const { rows: [row] } = await query(
        `INSERT INTO ${CT.suggestions} (guild_id, user_id, content, channel_id) VALUES ($1, $2, $3, $4) RETURNING *`,
        [guild.id, user.id, text, channel.id]
    );
    let message;
    try {
        message = await channel.send(buildSuggestionMessage(row, user));
    } catch (error) {
        await query(`DELETE FROM ${CT.suggestions} WHERE id = $1`, [row.id]).catch(() => {});
        lastSuggested.delete(`${guild.id}:${user.id}`);
        logger.warn(`Suggestion could not be posted in ${channel.id}: ${error.message}`);
        throw userError(`I could not post in ${channel}. Ask an admin to check my permissions there.`);
    }
    await query(`UPDATE ${CT.suggestions} SET message_id = $2 WHERE id = $1`, [row.id, message.id]);
    return { row: { ...row, message_id: message.id }, message };
}

/**
 * Records a vote click. Returns { row, vote } with the recounted row, or null
 * when the suggestion does not exist. Throws a user error when voting is closed.
 */
export async function castVote({ suggestionId, guildId, userId, clicked }) {
    return withTransaction(async (client) => {
        const { rows: [suggestion] } = await client.query(
            `SELECT id, status FROM ${CT.suggestions} WHERE id = $1 AND guild_id = $2 FOR UPDATE`,
            [suggestionId, guildId]
        );
        if (!suggestion) return null;
        if (!isVotingOpen(suggestion.status)) throw userError('Voting on this suggestion is closed.');
        const { rows: [existing] } = await client.query(
            `SELECT vote FROM ${CT.suggestionVotes} WHERE suggestion_id = $1 AND user_id = $2`,
            [suggestionId, userId]
        );
        const vote = nextVote(existing?.vote ?? 0, clicked);
        if (vote === 0) {
            await client.query(`DELETE FROM ${CT.suggestionVotes} WHERE suggestion_id = $1 AND user_id = $2`, [suggestionId, userId]);
        } else {
            await client.query(
                `INSERT INTO ${CT.suggestionVotes} (suggestion_id, user_id, vote) VALUES ($1, $2, $3)
                 ON CONFLICT (suggestion_id, user_id) DO UPDATE SET vote = EXCLUDED.vote, voted_at = NOW()`,
                [suggestionId, userId, vote]
            );
        }
        const { rows: [row] } = await client.query(
            `UPDATE ${CT.suggestions} s SET
                upvotes = (SELECT COUNT(*) FROM ${CT.suggestionVotes} v WHERE v.suggestion_id = s.id AND v.vote = 1),
                downvotes = (SELECT COUNT(*) FROM ${CT.suggestionVotes} v WHERE v.suggestion_id = s.id AND v.vote = -1)
             WHERE s.id = $1 RETURNING *`,
            [suggestionId]
        );
        return { row, vote };
    });
}

/** Sets a status; returns the updated row or null when there is no such suggestion in the guild. */
export async function setSuggestionStatus({ guildId, suggestionId, status, reason, decidedBy }) {
    if (!SUGGESTION_STATUSES.includes(status)) throw userError('Status must be approved, denied or considering.');
    const text = String(reason ?? '').trim().slice(0, SUGGESTION_REASON_MAX) || null;
    const { rows: [row] } = await query(
        `UPDATE ${CT.suggestions} SET status = $3, status_reason = $4, decided_by = $5, decided_at = NOW()
         WHERE guild_id = $1 AND id = $2 RETURNING *`,
        [guildId, suggestionId, status, text, decidedBy]
    );
    return row || null;
}

/** Open suggestions (still taking votes: pending or considering), newest first, at most `limit`. */
export async function listOpenSuggestions(guildId, limit = 25) {
    const { rows } = await query(
        `SELECT * FROM ${CT.suggestions} WHERE guild_id = $1 AND status IN ('pending', 'considering')
         ORDER BY id DESC LIMIT $2`,
        [guildId, Math.max(1, Math.min(100, Number(limit) || 25))]
    );
    return rows;
}

/**
 * A staff decision, as /suggest status does it: sets the status, updates the
 * suggestion message and DMs the author. Returns { row, edited, dmed }, or null when
 * there is no such suggestion in the guild.
 */
export async function decideSuggestion({ client, guild, suggestionId, status, reason, decidedBy }) {
    const row = await setSuggestionStatus({ guildId: guild.id, suggestionId, status, reason, decidedBy });
    if (!row) return null;
    const edited = await refreshSuggestionMessage(client, row);
    const dmed = await notifySuggestionAuthor(client, row, guild.name);
    return { row, edited, dmed };
}

export async function getSuggestion(guildId, suggestionId) {
    const { rows: [row] } = await query(`SELECT * FROM ${CT.suggestions} WHERE guild_id = $1 AND id = $2`, [guildId, suggestionId]);
    return row || null;
}

/** Re-renders the suggestion message after a status change; true when it was edited. */
export async function refreshSuggestionMessage(client, row) {
    if (!row.channel_id || !row.message_id) return false;
    try {
        const channel = client.channels.cache.get(row.channel_id) || await client.channels.fetch(row.channel_id);
        const message = await channel.messages.fetch(row.message_id);
        const author = await client.users.fetch(row.user_id).catch(() => null);
        await message.edit(buildSuggestionMessage(row, author));
        return true;
    } catch (error) {
        logger.warn(`Suggestion #${row.id} message could not be updated: ${error.message}`);
        return false;
    }
}

/** DMs the author about a status change; true when delivered. */
export async function notifySuggestionAuthor(client, row, guildName) {
    try {
        const user = await client.users.fetch(row.user_id);
        await user.send({
            embeds: [createEmbed({
                title: `Your suggestion #${row.id} in ${guildName}: ${STATUS_LABEL[row.status]}`,
                description: row.content.length > 1000 ? `${row.content.slice(0, 999)}…` : row.content,
                color: STATUS_COLOR[row.status],
                fields: row.status_reason ? [{ name: 'Reason', value: row.status_reason }] : [],
            })],
            allowedMentions: { parse: [] },
        });
        return true;
    } catch (error) {
        logger.info(`Suggestion DM to ${row.user_id} failed: ${error.message}`);
        return false;
    }
}

/** For tests. */
export function resetSuggestionCooldownsForTests() {
    lastSuggested.clear();
}
