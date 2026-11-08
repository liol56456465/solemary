// dmLog.js — the bot DM log (schema v13, table bot_dm_log) and sendLoggedDm, the one way the
// main DM paths send a DM that a later language change can edit (dmRelang.js).
//
// What is stored, per DM: the server it is about, the member, the DM channel and message id,
// the template key (dmRenderers.js) and its params (only what the DM showed), the language it
// is in now, and when it was sent. Only for servers that have language roles (no language role,
// nothing to re-edit, nothing stored). Kept 30 days (DM_LOG_DAYS): the daily retention job
// deletes older rows (privacy/retentionService.js), /wipedata deletes a member's rows.
//
// The log is a helper, not a record: a DM that was delivered stays delivered when its row cannot
// be written (logged; that DM is just never re-edited). Reads for the re-edit throw on a database
// error (the re-edit then does nothing).

import { pgConfig } from '../../config/database/postgres.js';
import { logger } from '../../utils/logger.js';
import { LANGUAGE_ROLES_KEY, resolveBotLanguage } from '../../utils/botText.js';
import { resolveSetting } from '../settings/guildSettings.js';
import { isEnforcementDbAvailable, query as dbQuery } from '../enforcement/db.js';
import { renderDm } from './dmRenderers.js';

export const DM_LOG_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const ID = /^\d{17,20}$/;
const NO_MENTIONS = Object.freeze({ parse: [] });

const table = (tables = pgConfig.tables) => tables.bot_dm_log;

/** True when this server has at least one language role (setting languageRoles). Never throws. */
export function guildHasLanguageRoles(guildId, { resolve = resolveSetting } = {}) {
    if (!guildId) return false;
    try {
        const map = resolve(String(guildId), LANGUAGE_ROLES_KEY);
        return Boolean(map && typeof map === 'object' && Object.values(map).some(Boolean));
    } catch {
        return false;
    }
}

/** The member from the bot's cache (no API call), so their language role applies; else null. */
function cachedMember(user, guildId) {
    if (!guildId) return null;
    return user?.client?.guilds?.cache?.get?.(String(guildId))?.members?.cache?.get?.(user.id) ?? null;
}

/** Stores one sent DM. Throws on a database error. */
export async function insertDmLog({ guildId, userId, channelId, messageId, key, params, lang }, { query = dbQuery, tables } = {}) {
    await query(
        `INSERT INTO ${table(tables)} (guild_id, user_id, channel_id, message_id, template_key, params, lang)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         ON CONFLICT (message_id) DO NOTHING`,
        [String(guildId), String(userId), String(channelId), String(messageId), key, JSON.stringify(params ?? {}), lang]);
}

/**
 * The member's logged DMs about one server from the last DM_LOG_DAYS days that are not in `lang`
 * yet, newest first, at most `limit`. Throws on a database error.
 */
export async function listDmsToRelang({ guildId, userId, lang, limit = 50, now = Date.now() }, { query = dbQuery, tables } = {}) {
    const { rows } = await query(
        `SELECT id, channel_id, message_id, template_key, params, lang, created_at
         FROM ${table(tables)}
         WHERE guild_id = $1 AND user_id = $2 AND created_at >= $3 AND lang <> $4
         ORDER BY created_at DESC, id DESC
         LIMIT $5`,
        [String(guildId), String(userId), new Date(now - DM_LOG_DAYS * DAY_MS), lang, limit]);
    return rows;
}

/** A DM that is gone (deleted) or must not be edited any more: its row goes. */
export async function deleteDmLogRow(id, { query = dbQuery, tables } = {}) {
    await query(`DELETE FROM ${table(tables)} WHERE id = $1`, [id]);
}

/** After an edit: the language the DM is in now. */
export async function setDmLogLang(id, lang, { query = dbQuery, tables } = {}) {
    await query(`UPDATE ${table(tables)} SET lang = $2 WHERE id = $1`, [id, lang]);
}

/** /wipedata: every logged DM to this member (all servers). Throws on a database error. */
export async function deleteDmLogForUser(userId, { query = dbQuery, tables } = {}) {
    const result = await query(`DELETE FROM ${table(tables)} WHERE user_id = $1`, [String(userId)]);
    return result?.rowCount || 0;
}

/** Retention: rows older than DM_LOG_DAYS days, at most `limit` per run. Throws on a database error. */
export async function pruneDmLog({ query = dbQuery, tables, now = Date.now(), limit = 5000 } = {}) {
    const t = table(tables);
    const result = await query(
        `DELETE FROM ${t} WHERE id IN (SELECT id FROM ${t} WHERE created_at < $1 LIMIT $2)`,
        [new Date(now - DM_LOG_DAYS * DAY_MS), limit]);
    return result?.rowCount || 0;
}

/**
 * Sends a DM built from a template (dmRenderers.js) and logs it for a later language change.
 * The language: resolveBotLanguage purpose 'dm' with the member (passed, else from the bot's
 * cache), so a language role applies. Returns true when Discord accepted the DM, false when it
 * did not (DMs closed, no mutual server …; logged at info). A template that fails in English
 * throws (code bug), exactly like building the text before sending did.
 *
 * @param {import('discord.js').User} user
 * @param {object} o
 * @param {string} o.key           template key (dmRenderers.js)
 * @param {object} [o.params]      what the template needs; only what the DM shows
 * @param {string|null} [o.guildId] the server the DM is about (none: never logged)
 * @param {object|null} [o.member]  the member, when the caller has it
 * @param {Array} [o.components]    extra components (not re-rendered later, e.g. "Contest this")
 * @param {Array} [o.files]         attachments (kept as they are on a later edit)
 * @param {string} [o.label]        what the DM is, for the failure log line
 * @param {object} [deps]           tests: { insert, dbAvailable, hasLanguageRoles, resolveLanguage, render }
 */
export async function sendLoggedDm(user, { key, params = {}, guildId = null, member = null, components = null, files = null, label = key } = {}, deps = {}) {
    const {
        insert = insertDmLog,
        dbAvailable = isEnforcementDbAvailable,
        hasLanguageRoles = guildHasLanguageRoles,
        resolveLanguage = resolveBotLanguage,
        render = renderDm,
    } = deps;
    if (!user?.send) return false;
    const lang = resolveLanguage({ guildId, member: member ?? cachedMember(user, guildId), userId: user.id, purpose: 'dm' });
    const payload = await render(key, params, lang);
    const extraComponents = components?.length ? components : null;
    let message;
    try {
        message = await user.send({
            ...payload,
            ...(extraComponents ? { components: [...(payload.components || []), ...extraComponents] } : {}),
            ...(files?.length ? { files } : {}),
            allowedMentions: NO_MENTIONS,
        });
    } catch (error) {
        logger.info(`DM ${label} to ${user.id} failed: ${error?.message || error}`);
        return false;
    }
    try {
        if (guildId && ID.test(String(guildId)) && message?.id && message?.channelId
            && hasLanguageRoles(guildId) && dbAvailable()) {
            await insert({ guildId, userId: user.id, channelId: message.channelId, messageId: message.id, key, params, lang });
        }
    } catch (error) {
        logger.warn(`DM ${label} to ${user.id} was sent but not logged for a language change: ${error?.message || error}`);
    }
    return true;
}
