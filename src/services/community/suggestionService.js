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
import { botText, textForGuild } from '../../utils/botText.js';
import { sendLoggedDm } from '../botDm/dmLog.js';

export const SUGGESTION_MAX_LENGTH = 1500;
export const SUGGESTION_REASON_MAX = 500;
export const SUGGESTION_COOLDOWN_MS = 2 * 60 * 1000;
export const SUGGESTION_STATUSES = ['approved', 'denied', 'considering'];
export const VOTE_BUTTON_ID = 'suggest_vote';

// Status labels in the bot catalog (English: Open for votes, Approved, Denied, Under consideration).
const STATUS_LABEL_KEYS = {
    pending: 'community.suggest.label.pending', approved: 'community.suggest.label.approved',
    denied: 'community.suggest.label.denied', considering: 'community.suggest.label.considering',
};
const statusLabel = (tr, status) => (STATUS_LABEL_KEYS[status] ? tr.t(STATUS_LABEL_KEYS[status]) : status);
/** The language of the suggestion post: the server's (a public post). */
const postLang = (guildId) => textForGuild(guildId, { purpose: 'public' }).lang;
const STATUS_COLOR = { pending: 'primary', approved: 'success', denied: 'error', considering: 'warning' };
const lastSuggested = new Map(); // guildId:userId → ms

export function isVotingOpen(status) {
    return status === 'pending' || status === 'considering';
}

/** Vote after a click: same button again withdraws (0), otherwise the clicked one; pure. */
export function nextVote(current, clicked) {
    return current === clicked ? 0 : clicked;
}

/** The suggestion message (embed + buttons) for a row; pure. lang: the server's (a public post). */
export function buildSuggestionMessage(row, author = null, { lang = 'en' } = {}) {
    const tr = botText(lang);
    const fields = [
        { name: tr.t('community.suggest.votes'), value: `👍 ${row.upvotes}  ·  👎 ${row.downvotes}`, inline: true },
        { name: tr.t('community.suggest.status'), value: statusLabel(tr, row.status), inline: true },
    ];
    if (row.status !== 'pending' && row.status_reason) {
        fields.push({ name: row.decided_by ? tr.t('community.suggest.reasonStaff') : tr.t('community.suggest.reason'), value: row.status_reason });
    }
    const embed = createEmbed({
        title: tr.t('community.suggest.title', { id: row.id }),
        description: row.content,
        color: STATUS_COLOR[row.status] || 'primary',
        fields,
        author: author
            ? { name: author.username, ...(author.displayAvatarURL ? { iconURL: author.displayAvatarURL() } : {}) }
            : { name: tr.t('community.suggest.member', { userId: row.user_id }) },
        footer: { text: tr.t('community.suggest.footer') },
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

/** Posts a suggestion; returns { row, message }. lang: the language of the errors (the member's). */
export async function createSuggestion({ guild, user, content, lang = 'en' }) {
    const tr = botText(lang);
    const text = String(content ?? '').trim();
    if (!text) throw userError(tr.t('community.suggest.empty'));
    if (text.length > SUGGESTION_MAX_LENGTH) throw userError(tr.t('community.suggest.tooLong', { max: SUGGESTION_MAX_LENGTH }));
    const { suggestionsChannelId } = getCommunitySettings(guild.id);
    const channel = suggestionsChannelId ? guild.channels.cache.get(suggestionsChannelId) : null;
    if (!channel) throw userError(tr.t('community.suggest.notSetUp'));
    const left = takeSuggestionSlot(guild.id, user.id);
    if (left > 0) throw userError(tr.t('community.suggest.cooldown', { seconds: Math.ceil(left / 1000) }));

    const { rows: [row] } = await query(
        `INSERT INTO ${CT.suggestions} (guild_id, user_id, content, channel_id) VALUES ($1, $2, $3, $4) RETURNING *`,
        [guild.id, user.id, text, channel.id]
    );
    let message;
    try {
        message = await channel.send(buildSuggestionMessage(row, user, { lang: postLang(guild.id) }));
    } catch (error) {
        await query(`DELETE FROM ${CT.suggestions} WHERE id = $1`, [row.id]).catch(() => {});
        lastSuggested.delete(`${guild.id}:${user.id}`);
        logger.warn(`Suggestion could not be posted in ${channel.id}: ${error.message}`);
        throw userError(tr.t('community.suggest.postFailed', { channel: String(channel) }));
    }
    await query(`UPDATE ${CT.suggestions} SET message_id = $2 WHERE id = $1`, [row.id, message.id]);
    return { row: { ...row, message_id: message.id }, message };
}

/**
 * Records a vote click. Returns { row, vote } with the recounted row, or null
 * when the suggestion does not exist. Throws a user error when voting is closed.
 */
export async function castVote({ suggestionId, guildId, userId, clicked, lang = 'en' }) {
    return withTransaction(async (client) => {
        const { rows: [suggestion] } = await client.query(
            `SELECT id, status FROM ${CT.suggestions} WHERE id = $1 AND guild_id = $2 FOR UPDATE`,
            [suggestionId, guildId]
        );
        if (!suggestion) return null;
        if (!isVotingOpen(suggestion.status)) throw userError(botText(lang).t('community.suggest.closed'));
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
export async function setSuggestionStatus({ guildId, suggestionId, status, reason, decidedBy, lang = 'en' }) {
    if (!SUGGESTION_STATUSES.includes(status)) throw userError(botText(lang).t('community.suggest.statusInvalid'));
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
export async function decideSuggestion({ client, guild, suggestionId, status, reason, decidedBy, lang = 'en' }) {
    const row = await setSuggestionStatus({ guildId: guild.id, suggestionId, status, reason, decidedBy, lang });
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
        await message.edit(buildSuggestionMessage(row, author, { lang: postLang(row.guild_id) }));
        return true;
    } catch (error) {
        logger.warn(`Suggestion #${row.id} message could not be updated: ${error.message}`);
        return false;
    }
}

/**
 * The author's status DM in a language (botDm/dmRenderers.js 'suggestion.status'). `p`: id,
 * serverName, status, content (the suggestion as the DM shows it: at most 1000 characters),
 * statusReason (staff-written, as given). Pure.
 */
export function suggestionDmPayload(p, lang = 'en') {
    const tr = botText(lang);
    return {
        embeds: [createEmbed({
            title: tr.t('community.suggest.dmTitle', { id: p.id, server: p.serverName, status: statusLabel(tr, p.status) }),
            description: p.content,
            color: STATUS_COLOR[p.status],
            fields: p.statusReason ? [{ name: tr.t('community.suggest.reason'), value: p.statusReason }] : [],
        })],
    };
}

/**
 * DMs the author about a status change (their language role, else the server's language; logged
 * for a language change, botDm/dmLog.js); true when delivered.
 */
export async function notifySuggestionAuthor(client, row, guildName) {
    try {
        const user = await client.users.fetch(row.user_id);
        const content = String(row.content ?? '');
        return await sendLoggedDm(user, {
            key: 'suggestion.status',
            params: {
                id: row.id, serverName: guildName, status: row.status,
                content: content.length > 1000 ? `${content.slice(0, 999)}…` : content,
                statusReason: row.status_reason || null,
            },
            guildId: row.guild_id,
            member: client.guilds?.cache?.get?.(String(row.guild_id))?.members?.cache?.get?.(row.user_id) ?? null,
            label: 'suggestion status',
        });
    } catch (error) {
        logger.info(`Suggestion DM to ${row.user_id} failed: ${error.message}`);
        return false;
    }
}

/** For tests. */
export function resetSuggestionCooldownsForTests() {
    lastSuggested.clear();
}
