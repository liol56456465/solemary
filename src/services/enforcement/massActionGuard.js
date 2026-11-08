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

import { botConfig } from '../../config/bot.js';
import { hasOwnerPower, isMewvoServer } from '../../utils/ownerPower.js';
import { db } from '../../utils/database/wrapper.js';
import { createError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { query, T } from './db.js';
import { resolveSetting } from '../settings/guildSettings.js';


const blockKey = (guildId, moderatorId) => `enforcement:massguard:${guildId}:${moderatorId}`;

function blockedError(block, guildId) {
    const until = Math.floor(new Date(block.until).getTime() / 1000);
    const alerted = isMewvoServer(guildId) ? 'The bot owners were alerted.' : 'The server owner was alerted.';
    return createError(`Moderator blocked by the mass-action guard until ${block.until}`, ErrorTypes.PERMISSION,
        `Safety limit: you are blocked from the enforcement panel until <t:${until}:t> (<t:${until}:R>) after ${block.count} ${block.attempted === 'mute' ? 'mutes' : 'bans/kicks'} in a short time. ${alerted}`,
        { expected: true });
}

export async function getMassActionBlock(guildId, moderatorId) {
    const block = await db.get(blockKey(guildId, moderatorId), null);
    return block && new Date(block.until).getTime() > Date.now() ? block : null;
}

/** Every moderator currently blocked in a guild: [{ moderatorId, until, count, attempted, at }]. */
export async function listMassActionBlocks(guildId) {
    const prefix = blockKey(guildId, '');
    const keys = await db.list(prefix).catch(() => []);
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

async function alertOwners(client, recipients, text) {
    for (const ownerId of recipients) {
        const owner = await client.users.fetch(ownerId).catch(() => null);
        await owner?.send({ content: text, allowedMentions: { parse: [] } })
            .catch((error) => logger.warn(`Mass-action alert DM to ${ownerId} failed: ${error.message}`));
    }
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

    // Imported lazily: enforcementService imports this module.
    const { postModLog } = await import('./enforcementService.js');
    await postModLog(guild.client, 'massguard', [
        { name: 'Moderator', value: `<@${moderator.id}> (${moderator.id})` },
        { name: 'What happened', value: summary },
        { name: 'Blocked until', value: `<t:${Math.floor(Date.parse(until) / 1000)}:f>` },
        { name: 'Lift early', value: '`/staff restore`' },
    ], { title: `Safety limit: too many ${what} in ${windowMinutes} minutes, moderator blocked`, guildId: guild.id });
    await alertOwners(guild.client, massAlertRecipients(guild, moderator.id), `**Safety limit (too many ${what} in ${windowMinutes} minutes) in ${guild.name}.** ${summary} Their panel access is blocked until <t:${Math.floor(Date.parse(until) / 1000)}:f>. Lift it early with \`/staff restore\`.`);
    return block;
}

/**
 * Call before every panel action. Throws while the moderator is blocked; for a
 * ban/kick over the limit it blocks them, alerts the owners and throws. A warn that
 * will trigger a ladder ban is passed in as 'ban' (see executeAction).
 */
export async function enforceMassActionGuard(guild, moderator, actionType) {
    // OWNER_IDS are exempt in Mewvo's own servers only.
    if (hasOwnerPower(moderator.id, guild.id)) return;
    const existing = await getMassActionBlock(guild.id, moderator.id);
    if (existing) throw blockedError(existing, guild.id);
    let count;
    let limit;
    if (actionType === 'ban' || actionType === 'kick') {
        count = await recentBanKickCount(guild.id, moderator.id);
        limit = resolveSetting(guild.id, 'massActionLimit');
    } else if (actionType === 'mute') {
        count = await recentMuteCount(guild.id, moderator.id);
        limit = resolveSetting(guild.id, 'massMuteLimit');
    } else {
        return;
    }
    if (count >= limit) {
        throw blockedError(await blockModerator(guild, moderator, count, actionType), guild.id);
    }
}
