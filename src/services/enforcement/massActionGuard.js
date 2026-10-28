// massActionGuard.js — stops one moderator from mass-banning through the panel.
//
// Panel actions are executed by the bot account, so the audit-log staff guard
// (automod/staffGuardService.js) never sees them. This guard counts the
// moderator's own ban/kick cases instead: with MASS_ACTION_LIMIT of them inside
// MASS_ACTION_WINDOW_MINUTES, the next ban/kick is refused and the moderator is
// blocked from every panel action for MASS_ACTION_BLOCK_MINUTES. OWNER_IDS get a
// DM and the alerts channel gets an entry. The block is stored with a TTL, so a restart
// doesn't lift it; /staff restore lifts it early.

import { enforcementConfig } from '../../config/enforcement.js';
import { botConfig, isBotOwner } from '../../config/bot.js';
import { db } from '../../utils/database/wrapper.js';
import { createError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { query, T } from './db.js';

const GUARDED_TYPES = new Set(['ban', 'kick']);

const blockKey = (guildId, moderatorId) => `enforcement:massguard:${guildId}:${moderatorId}`;

function blockedError(block) {
    const until = Math.floor(new Date(block.until).getTime() / 1000);
    return createError(`Moderator blocked by the mass-action guard until ${block.until}`, ErrorTypes.PERMISSION,
        `You are blocked from the enforcement panel until <t:${until}:t> (<t:${until}:R>) after ${block.count} bans/kicks in a short time. The bot owners were alerted.`,
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
export async function recentBanKickCount(guildId, moderatorId, windowMs = enforcementConfig.massActionWindowMs) {
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

async function alertOwners(client, text) {
    for (const ownerId of botConfig.commands?.owners ?? []) {
        const owner = await client.users.fetch(ownerId).catch(() => null);
        await owner?.send({ content: text, allowedMentions: { parse: [] } })
            .catch((error) => logger.warn(`Mass-action alert DM to ${ownerId} failed: ${error.message}`));
    }
}

async function blockModerator(guild, moderator, count, attempted) {
    const until = new Date(Date.now() + enforcementConfig.massActionBlockMs).toISOString();
    const block = { until, count, attempted, at: new Date().toISOString() };
    await db.set(blockKey(guild.id, moderator.id), block, Math.ceil(enforcementConfig.massActionBlockMs / 1000));

    const windowMinutes = Math.round(enforcementConfig.massActionWindowMs / 60000);
    const summary = `${moderator.user?.username ?? moderator.id} (${moderator.id}) made ${count} bans/kicks within ${windowMinutes} minutes and tried another ${attempted}.`;
    logger.warn(`Mass-action guard in ${guild.id}: ${summary} Blocked until ${until}.`);

    // Imported lazily: enforcementService imports this module.
    const { postModLog } = await import('./enforcementService.js');
    await postModLog(guild.client, 'massguard', [
        { name: 'Moderator', value: `<@${moderator.id}> (${moderator.id})` },
        { name: 'What happened', value: summary },
        { name: 'Blocked until', value: `<t:${Math.floor(Date.parse(until) / 1000)}:f>` },
        { name: 'Lift early', value: '`/staff restore`' },
    ], { title: '🛡️ Mass-action guard: moderator blocked' });
    await alertOwners(guild.client, `**Mass-action guard in ${guild.name}.** ${summary} Their panel access is blocked until <t:${Math.floor(Date.parse(until) / 1000)}:f>. Lift it early with \`/staff restore\`.`);
    return block;
}

/**
 * Call before every panel action. Throws while the moderator is blocked; for a
 * ban/kick over the limit it blocks them, alerts the owners and throws. A warn that
 * will trigger a ladder ban is passed in as 'ban' (see executeAction).
 */
export async function enforceMassActionGuard(guild, moderator, actionType) {
    if (isBotOwner(moderator.id)) return;
    const existing = await getMassActionBlock(guild.id, moderator.id);
    if (existing) throw blockedError(existing);
    if (!GUARDED_TYPES.has(actionType)) return;

    const count = await recentBanKickCount(guild.id, moderator.id);
    if (count >= enforcementConfig.massActionLimit) {
        throw blockedError(await blockModerator(guild, moderator, count, actionType));
    }
}
