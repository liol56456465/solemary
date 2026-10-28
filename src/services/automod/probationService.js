// probationService.js — probation for members who rejoin the main server after a ban
// ended (expired, lifted on appeal, voided) within probationRecentBanMs.
//
// While on probation (probationMs, stored in the key-value store with a TTL):
// automod uses the next step of the rule's ladder, trusted-member relaxing and second
// chances don't apply, and every review card says "on probation". A line goes to the
// alerts channel when it starts; /automod probation ends it early.

import { automodConfig } from '../../config/automod.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { db, deleteFromDb, getFromDb, setInDb } from '../../utils/database.js';
import { logger } from '../../utils/logger.js';
import { query, T } from '../enforcement/db.js';
import { postModLog } from '../enforcement/enforcementService.js';
import { isProbationActive, shouldStartProbation } from './policy.js';

const CACHE_MS = 60 * 1000;
const cache = new Map(); // guildId:userId → { record, expiresAt }

const probationKey = (guildId, userId) => `automod:probation:${guildId}:${userId}`;

/** The running probation { startedAt, until, caseCode } or null. Throws on a DB error. */
export async function getProbation(guildId, userId, now = Date.now()) {
    const cacheKey = `${guildId}:${userId}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now) return isProbationActive(cached.record, now) ? cached.record : null;
    const record = await getFromDb(probationKey(guildId, userId), null);
    cache.set(cacheKey, { record, expiresAt: now + CACHE_MS });
    if (cache.size > 5000) for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
    return isProbationActive(record, now) ? record : null;
}

/**
 * The most recent ban that ended within the window, and whether a ban is still active.
 * { endedBan: { caseCode, endedAt, how } | null, hasActiveBan }. Throws on a DB error.
 */
export async function findRecentBanEnd(guildId, userId, recentMs = automodConfig.probationRecentBanMs) {
    const [ended, active] = await Promise.all([
        query(
            `SELECT case_code, status, voided_at, revoke_reason, COALESCE(revoked_at, expires_at) AS ended_at
             FROM ${T.cases}
             WHERE guild_id = $1 AND target_user_id = $2 AND type = 'ban' AND is_test = FALSE
               AND status IN ('expired', 'revoked')
               AND COALESCE(revoked_at, expires_at) > NOW() - ($3::bigint * INTERVAL '1 millisecond')
               AND COALESCE(revoked_at, expires_at) <= NOW()
             ORDER BY ended_at DESC
             LIMIT 1`,
            [guildId, userId, recentMs]
        ),
        query(
            `SELECT 1 FROM ${T.cases}
             WHERE guild_id = $1 AND target_user_id = $2 AND type = 'ban' AND is_test = FALSE
               AND status IN ('active', 'appeal_pending')
             LIMIT 1`,
            [guildId, userId]
        ),
    ]);
    const row = ended.rows[0];
    const endedBan = row ? {
        caseCode: row.case_code,
        endedAt: row.ended_at,
        how: row.voided_at ? 'voided' : row.status === 'expired' ? 'expired'
            : /^Appeal accepted/.test(row.revoke_reason || '') ? 'appeal accepted' : 'lifted',
    } : null;
    return { endedBan, hasActiveBan: active.rows.length > 0 };
}

/** Starts probation; resolves the record or throws. */
export async function startProbation(guildId, userId, { caseCode = null, how = null } = {}, now = Date.now()) {
    const record = { startedAt: now, until: now + automodConfig.probationMs, caseCode, how };
    await setInDb(probationKey(guildId, userId), record, Math.ceil(automodConfig.probationMs / 1000));
    cache.set(`${guildId}:${userId}`, { record, expiresAt: now + CACHE_MS });
    return record;
}

/** Ends probation early. Resolves the record that was running, or null. */
export async function endProbation(guildId, userId) {
    const existing = await getProbation(guildId, userId);
    await deleteFromDb(probationKey(guildId, userId));
    cache.set(`${guildId}:${userId}`, { record: null, expiresAt: Date.now() + CACHE_MS });
    return existing;
}

/**
 * Every running probation in a guild, soonest end first: [{ userId, startedAt, until,
 * caseCode, how }] (for the dashboard). Throws on a DB error.
 */
export async function listProbations(guildId, now = Date.now()) {
    const prefix = probationKey(guildId, '');
    const keys = await db.list(prefix);
    const out = [];
    for (const key of keys || []) {
        const userId = String(key).slice(prefix.length);
        if (!/^\d{17,20}$/.test(userId)) continue;
        const record = await getProbation(guildId, userId, now);
        if (record) out.push({ userId, ...record });
    }
    return out.sort((a, b) => Number(a.until) - Number(b.until));
}

/** "⚠️ on probation (rejoined after ban, until <t:…:D>)" */
export function probationLabel(record) {
    if (!record) return null;
    return `⚠️ on probation (rejoined after ban, until <t:${Math.floor(Number(record.until) / 1000)}:D>)`;
}

/** guildMemberAdd in the main server: put a member back from a recent ban on probation. */
export async function startProbationOnJoin(member, now = Date.now()) {
    const { guild } = member;
    if (guild.id !== enforcementConfig.mainGuildId || member.user?.bot) return null;
    const [existing, ban] = await Promise.all([
        getProbation(guild.id, member.id, now),
        findRecentBanEnd(guild.id, member.id),
    ]);
    if (!shouldStartProbation({ ...ban, existing, now })) return null;
    const record = await startProbation(guild.id, member.id, ban.endedBan, now);
    logger.info(`Automod probation started for ${member.id} (ban ${ban.endedBan.caseCode} ${ban.endedBan.how})`);
    await postModLog(member.client, 'automod', [
        { name: 'Member', value: `<@${member.id}> ${member.user?.username || ''} (${member.id})` },
        { name: 'Ban', value: `\`${ban.endedBan.caseCode}\` (${ban.endedBan.how}, ended <t:${Math.floor(new Date(ban.endedBan.endedAt).getTime() / 1000)}:R>)` },
        { name: 'Until', value: `<t:${Math.floor(record.until / 1000)}:F>` },
        { name: 'Effect', value: 'Automod uses the next step of the ladder for them; no second chance or trusted relaxing. End early with `/automod probation`.' },
    ], { title: '⚠️ Probation started (rejoined after a ban)' });
    return record;
}

/** Test hook. */
export function resetProbationCache() {
    cache.clear();
}
