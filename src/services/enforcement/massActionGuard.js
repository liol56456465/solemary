// massActionGuard.js — stops one moderator from mass-banning through the panel.
//
// Panel actions are executed by the bot account, so the audit-log staff guard
// (automod/staffGuardService.js) never sees them. This guard counts the
// moderator's own ban/kick cases instead: with MASS_ACTION_LIMIT of them inside
// MASS_ACTION_WINDOW_MINUTES, the next ban/kick is refused and the moderator is
// blocked from every panel action for MASS_ACTION_BLOCK_MINUTES. Mutes have their own,
// higher count (MASS_MUTE_LIMIT) in the same window, with the same block. The alerts channel
// gets an entry and a DM goes out: in Mewvo's own servers to OWNER_IDS (who are exempt there),
// in any other server to that server's owner (guild.ownerId); OWNER_IDS have no exemption
// there (utils/ownerPower.js). The block is stored with a TTL, so a restart doesn't lift it;
// /staff restore lifts it early.
// Undo always works (audit 1.4): Unban and Unmute are never refused, also while blocked. The
// action that reaches the limit gets a heads-up ("1 more … pauses your panel"). The refusal says
// "… was alerted" only when an alert DM was actually delivered, and names `/staff restore`.

import { botConfig } from '../../config/bot.js';
import { hasOwnerPower, isMewvoServer } from '../../utils/ownerPower.js';
import { db } from '../../utils/database/wrapper.js';
import { createError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { botText, textForGuild } from '../../utils/botText.js';
import { query, T } from './db.js';
import { resolveSetting } from '../settings/guildSettings.js';


const blockKey = (guildId, moderatorId) => `enforcement:massguard:${guildId}:${moderatorId}`;

/** Undo actions: never refused by the guard, also while blocked (audit 1.4). */
export const ALWAYS_ALLOWED_ACTIONS = Object.freeze(new Set(['unban', 'unmute']));

/**
 * The refusal the blocked moderator sees. `lang`: theirs when the caller knows it (the panel);
 * else English (the web dashboard shows bot errors in English). "… was alerted" only when the
 * block records a delivered alert DM (block.alerted; a block stored before that field: none).
 * Then who can lift it: the owner in Mewvo's own servers, an administrator elsewhere (/staff restore).
 */
export function blockedError(block, guildId, lang = 'en', { isHome = isMewvoServer } = {}) {
    const tr = botText(lang || 'en');
    const until = Math.floor(new Date(block.until).getTime() / 1000);
    const home = isHome(guildId);
    const parts = [];
    if (block.alerted === 'owners') parts.push(tr.t('staff.staff.massGuard.alertedOwners'));
    else if (block.alerted === 'owner') parts.push(tr.t('staff.staff.massGuard.alertedOwner'));
    parts.push(tr.t(home ? 'staff.staff.massGuard.liftHome' : 'staff.staff.massGuard.liftOther'));
    const params = { until, count: block.count, alerted: parts.join(' ') };
    return createError(`Moderator blocked by the mass-action guard until ${block.until}`, ErrorTypes.PERMISSION,
        block.attempted === 'mute' ? tr.t('staff.staff.massGuard.blockedMutes', params) : tr.t('staff.staff.massGuard.blockedBans', params),
        { expected: true });
}

export async function getMassActionBlock(guildId, moderatorId) {
    const block = await db.get(blockKey(guildId, moderatorId), null);
    return block && new Date(block.until).getTime() > Date.now() ? block : null;
}

/**
 * Every moderator currently blocked in a guild: [{ moderatorId, until, count, attempted, at }].
 * A database error throws (the staff page says "could not be loaded"), never an empty list.
 * One read per key: the key-value store has no value-returning list or getMany.
 */
export async function listMassActionBlocks(guildId) {
    const prefix = blockKey(guildId, '');
    const keys = await db.list(prefix);
    const out = [];
    for (const key of keys) {
        const moderatorId = String(key).slice(prefix.length);
        if (!/^\d{17,20}$/.test(moderatorId)) continue;
        const block = await getMassActionBlock(guildId, moderatorId);
        if (block) out.push({ moderatorId, ...block });
    }
    return out.sort((a, b) => String(a.until).localeCompare(String(b.until)));
}

export async function clearMassActionBlock(guildId, moderatorId) {
    await db.delete(blockKey(guildId, moderatorId));
}

/**
 * Bans/kicks this moderator caused within the window (test cases excluded): their own ban/kick
 * cases plus warn-ladder bans their warns triggered. A ladder ban is recorded under the bot, in
 * the same transaction as the warn, so both rows carry the same NOW() (transaction start time):
 * that is what ties the ban to the moderator's warn.
 */
export async function recentBanKickCount(guildId, moderatorId, windowMs = resolveSetting(guildId, 'massActionWindowMs')) {
    const { rows } = await query(
        `SELECT COUNT(*)::int AS n FROM ${T.cases} c
         WHERE c.guild_id = $1 AND NOT c.is_test
           AND c.created_at > NOW() - ($3::bigint * INTERVAL '1 millisecond')
           AND ((c.moderator_id = $2 AND c.type IN ('ban', 'kick'))
             OR (c.type = 'ban' AND c.is_auto AND c.reason_key = 'warn_ladder' AND EXISTS (
                   SELECT 1 FROM ${T.cases} w
                   WHERE w.guild_id = c.guild_id AND w.target_user_id = c.target_user_id AND w.type = 'warn'
                     AND w.moderator_id = $2 AND w.created_at = c.created_at)))`,
        [guildId, moderatorId, windowMs]
    );
    return rows[0]?.n ?? 0;
}

/** Mutes this moderator recorded within the window (test cases excluded). */
export async function recentMuteCount(guildId, moderatorId, windowMs = resolveSetting(guildId, 'massActionWindowMs')) {
    const { rows } = await query(
        `SELECT COUNT(*)::int AS n FROM ${T.cases}
         WHERE guild_id = $1 AND moderator_id = $2 AND type = 'mute' AND NOT is_test
           AND created_at > NOW() - ($3::bigint * INTERVAL '1 millisecond')`,
        [guildId, moderatorId, windowMs]
    );
    return rows[0]?.n ?? 0;
}

/**
 * Who gets the mass-action DM: OWNER_IDS for Mewvo's own servers (as before); for any other
 * server only its owner (guild.ownerId), never OWNER_IDS. A server owner who tripped the guard
 * themselves is not DM'd (the refusal already tells them). `owners`/`isHome` are for tests.
 */
export function massAlertRecipients(guild, moderatorId, { owners = botConfig.commands?.owners ?? [], isHome = isMewvoServer } = {}) {
    if (isHome(guild.id)) return [...owners].map(String);
    const ownerId = guild.ownerId ? String(guild.ownerId) : null;
    return ownerId && ownerId !== String(moderatorId) ? [ownerId] : [];
}

/** DMs every recipient; returns how many DMs were actually delivered (never throws). */
async function alertOwners(client, recipients, text) {
    let delivered = 0;
    for (const ownerId of recipients) {
        const owner = await client.users.fetch(ownerId).catch(() => null);
        if (!owner) {
            logger.warn(`Mass-action alert DM to ${ownerId} failed: user not found`);
            continue;
        }
        const sent = await owner.send({ content: text, allowedMentions: { parse: [] } })
            .then(() => true, (error) => {
                logger.warn(`Mass-action alert DM to ${ownerId} failed: ${error.message}`);
                return false;
            });
        if (sent) delivered += 1;
    }
    return delivered;
}

async function blockModerator(guild, moderator, count, attempted) {
    // This server's own limits (resolveSetting: a non-home server never gets the main server's values).
    const blockMs = resolveSetting(guild.id, 'massActionBlockMs');
    const until = new Date(Date.now() + blockMs).toISOString();
    const block = { until, count, attempted, at: new Date().toISOString() };
    await db.set(blockKey(guild.id, moderator.id), block, Math.ceil(blockMs / 1000));

    const windowMinutes = Math.round(resolveSetting(guild.id, 'massActionWindowMs') / 60000);
    const what = attempted === 'mute' ? 'mutes' : 'bans/kicks';
    const summary = `${moderator.user?.username ?? moderator.id} (${moderator.id}) made ${count} ${what} within ${windowMinutes} minutes and tried another ${attempted}.`;
    logger.warn(`Mass-action guard in ${guild.id}: ${summary} Blocked until ${until}.`);
    // Raid timeline (only while a lockdown runs). Imported lazily (raidService → enforcementService → here);
    // not awaited, never throws: the owner alert below must not wait for it.
    import('../automod/raidService.js')
        .then(({ noteIncidentEvent }) => noteIncidentEvent(guild.id, {
            kind: 'mass_block', actorId: moderator.id,
            detail: `Blocked for ${Math.round(blockMs / 60000)} minutes after ${count} ${what} within ${windowMinutes} minutes`,
        }))
        .catch((error) => logger.warn(`Raid timeline: mass-action event failed: ${error.message}`));

    // The mod log (a staff channel) and the owners' DM: the server's language.
    const tr = textForGuild(guild.id, { purpose: 'public' });
    const mutes = attempted === 'mute';
    const name = moderator.user?.username ?? moderator.id;
    const summaryParams = { name, id: moderator.id, count, minutes: windowMinutes };
    const localSummary = mutes
        ? tr.t('staff.staff.massGuard.summaryMutes', summaryParams)
        : (attempted === 'kick' ? tr.t('staff.staff.massGuard.summaryKick', summaryParams) : tr.t('staff.staff.massGuard.summaryBan', summaryParams));
    const untilStamp = Math.floor(Date.parse(until) / 1000);
    // Imported lazily: enforcementService imports this module.
    const { postModLog } = await import('./enforcementService.js');
    await postModLog(guild.client, 'massguard', [
        { name: tr.t('staff.staff.massGuard.moderator'), value: `<@${moderator.id}> (${moderator.id})` },
        { name: tr.t('staff.staff.massGuard.whatHappened'), value: localSummary },
        { name: tr.t('staff.staff.massGuard.blockedUntil'), value: `<t:${untilStamp}:f>` },
        { name: tr.t('staff.staff.massGuard.liftEarly'), value: '`/staff restore`' },
    ], { title: tr.t(mutes ? 'staff.staff.massGuard.titleMutes' : 'staff.staff.massGuard.titleBans', { minutes: windowMinutes }), guildId: guild.id });
    const dmParams = { minutes: windowMinutes, server: guild.name, summary: localSummary, until: untilStamp };
    const delivered = await alertOwners(guild.client, massAlertRecipients(guild, moderator.id), mutes ? tr.t('staff.staff.massGuard.dmMutes', dmParams) : tr.t('staff.staff.massGuard.dmBans', dmParams));
    if (delivered === 0) return block;
    // Who was told, for this refusal and the later ones (same TTL). Only while this very block is
    // still stored: a /staff restore during the DMs must not be undone by this write.
    const alerted = { ...block, alerted: isMewvoServer(guild.id) ? 'owners' : 'owner' };
    const remainingSeconds = Math.max(1, Math.ceil((Date.parse(until) - Date.now()) / 1000));
    try {
        const current = await getMassActionBlock(guild.id, moderator.id);
        if (current?.at === block.at) await db.set(blockKey(guild.id, moderator.id), alerted, remainingSeconds);
    } catch (error) {
        logger.warn(`Mass-action block of ${moderator.id} in ${guild.id}: alert note not stored: ${error.message}`);
    }
    return alerted;
}

/** The heads-up on the action that reaches the limit: one more pauses the panel. */
function lastOneWarning(guildId, actionType, lang) {
    const tr = botText(lang || 'en');
    const params = {
        minutes: Math.round(resolveSetting(guildId, 'massActionWindowMs') / 60000),
        block: Math.round(resolveSetting(guildId, 'massActionBlockMs') / 60000),
    };
    return tr.t(actionType === 'mute' ? 'staff.staff.massGuard.lastOneMutes' : 'staff.staff.massGuard.lastOneBans', params);
}

/**
 * Call before every panel action. Throws while the moderator is blocked; for a
 * ban/kick over the limit it blocks them, alerts the owners and throws. A warn that
 * will trigger a ladder ban is passed in as 'ban' (see executeAction). `lang`: the
 * moderator's language for the refusal when the caller has it (else English, e.g. the dashboard).
 * Unban and Unmute always pass (undo must work). Returns { warning } when this action is the
 * last one before the limit (the caller shows it), else nothing.
 */
export async function enforceMassActionGuard(guild, moderator, actionType, { lang = 'en' } = {}) {
    if (ALWAYS_ALLOWED_ACTIONS.has(actionType)) return undefined;
    // OWNER_IDS are exempt in Mewvo's own servers only.
    if (hasOwnerPower(moderator.id, guild.id)) return undefined;
    const existing = await getMassActionBlock(guild.id, moderator.id);
    if (existing) throw blockedError(existing, guild.id, lang);
    let count;
    let limit;
    if (actionType === 'ban' || actionType === 'kick') {
        count = await recentBanKickCount(guild.id, moderator.id);
        limit = resolveSetting(guild.id, 'massActionLimit');
    } else if (actionType === 'mute') {
        count = await recentMuteCount(guild.id, moderator.id);
        limit = resolveSetting(guild.id, 'massMuteLimit');
    } else {
        return undefined;
    }
    if (count >= limit) {
        throw blockedError(await blockModerator(guild, moderator, count, actionType), guild.id, lang);
    }
    // This one makes `limit`: the next one is refused and blocks.
    if (count === limit - 1) return { warning: lastOneWarning(guild.id, actionType, lang) };
    return undefined;
}
