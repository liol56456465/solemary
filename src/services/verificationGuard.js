// verificationGuard.js — extra checks before OAuth verification gives the role.
//
// A verification is held for staff instead of going through when:
//   - the Discord account is younger than MIN_ACCOUNT_AGE_MS, or
//   - it comes from the same network (IP hash) as a member with an active ban in the
//     same server: a likely ban-evasion alt. Per server since v12 (guardScope): Mewvo's own
//     servers share their history, any other server only sees its own.
// Staff get a card with Approve / Deny; the user sees a "waiting for approval" page.
//
// Privacy: only an HMAC of the IP is stored (keyed with OAUTH_TOKEN_KEY, or the client
// secret), never the address. Rows older than IP_RETENTION_MS are deleted, except for
// members with an active ban, whose hashes are what alts are matched against.
// Shared networks (schools, families, VPNs) can match by accident, which is why a
// match is only ever a hold for staff, never a refusal.

import crypto from 'crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, SnowflakeUtil } from 'discord.js';
import { enforcementConfig } from '../config/enforcement.js';
import { logger } from '../utils/logger.js';
import { createEmbed } from '../utils/embeds.js';
import { query, T, isEnforcementDbAvailable } from './enforcement/db.js';
import { OPEN_STATUSES } from './enforcement/caseService.js';
import { dateStamp, formatDuration, truncate } from './enforcement/format.js';
import { reviewChannel } from './automod/reviewCards.js';
import { STATUS_COLORS } from './automod/reviewFormat.js';
import { durationIn } from './enforcement/dmTemplates.js';
import { textForGuild } from '../utils/botText.js';

const DAY = 24 * 60 * 60 * 1000;
export const MIN_ACCOUNT_AGE_MS = 7 * DAY;
export const IP_RETENTION_MS = 60 * DAY;
const PRUNE_INTERVAL_MS = DAY;

let lastPrune = 0;

function hashKey() {
    return (process.env.OAUTH_TOKEN_KEY || '').trim() || (process.env.DISCORD_CLIENT_SECRET || '').trim();
}

export function hashIp(ip) {
    const key = hashKey();
    if (!ip || !key) return null;
    // IPv4-mapped IPv6 ("::ffff:1.2.3.4") is the same address as "1.2.3.4".
    const normalized = String(ip).trim().toLowerCase().replace(/^::ffff:/, '');
    return crypto.createHmac('sha256', key).update(`verify-ip:${normalized}`).digest('hex');
}

export function accountAgeMs(userId, now = Date.now()) {
    return now - SnowflakeUtil.timestampFrom(userId);
}

/**
 * Whose network history a verification in `guildId` is compared with (multi-server B1).
 * Mewvo's own servers (main + support) share theirs, as before v12; any other server only
 * sees its own rows and its own bans, so one server's verification never reveals or holds
 * members of another. `legacy`: also read verification_ips (pre-v12 rows, all from home servers).
 */
export function guardScope(guildId, config = enforcementConfig) {
    const id = String(guildId || '');
    const home = [...new Set([config.mainGuildId, config.supportGuildId].map((g) => String(g || '')).filter(Boolean))];
    if (id && home.includes(id)) return { guildIds: home, legacy: true };
    return { guildIds: id ? [id] : [], legacy: false };
}

/**
 * Deletes IP hashes not seen for IP_RETENTION_MS, except those of members with an active
 * ban in the row's server (home rows: in any of Mewvo's own servers; pre-v12 rows in
 * verification_ips are home rows). At most `limit` rows per call, both tables together.
 * Returns the count; throws on a database error. Run daily by the retention job
 * (privacy/retentionService.js) and, at most once a day, before a verification is checked.
 */
export async function pruneVerificationIpHashes({ q = query, now = Date.now(), limit = 5000, config = enforcementConfig } = {}) {
    const homeIds = guardScope(config.mainGuildId || config.supportGuildId, config).guildIds;
    const activeBan = (alias, guildCondition) => `NOT EXISTS (
                   SELECT 1 FROM ${T.cases} c
                   WHERE c.target_user_id = ${alias}.user_id AND ${guildCondition} AND c.type = 'ban' AND c.is_test = FALSE
                     AND c.status = ANY($3) AND (c.expires_at IS NULL OR c.expires_at > $4)
               )`;
    const cutoffAt = new Date(now - IP_RETENTION_MS);
    const legacy = await q(
        `DELETE FROM ${T.verificationIps} WHERE ctid IN (
             SELECT v.ctid FROM ${T.verificationIps} v
             WHERE v.seen_at < $1 AND ${activeBan('v', 'c.guild_id = ANY($2)')}
             LIMIT $5)`,
        [cutoffAt, homeIds, OPEN_STATUSES, new Date(now), limit]
    );
    const removed = legacy?.rowCount || 0;
    if (removed >= limit) return removed;
    const scoped = await q(
        `DELETE FROM ${T.verificationGuildIps} WHERE ctid IN (
             SELECT v.ctid FROM ${T.verificationGuildIps} v
             WHERE v.seen_at < $1
               AND ${activeBan('v', '(c.guild_id = v.guild_id OR (v.guild_id = ANY($2) AND c.guild_id = ANY($2)))')}
             LIMIT $5)`,
        [cutoffAt, homeIds, OPEN_STATUSES, new Date(now), limit - removed]
    );
    return removed + (scoped?.rowCount || 0);
}

async function pruneOldHashes() {
    const now = Date.now();
    if (now - lastPrune < PRUNE_INTERVAL_MS) return;
    lastPrune = now;
    await pruneVerificationIpHashes({ now })
        .catch((error) => logger.warn(`Could not prune verification IP hashes: ${error.message}`));
}

/** Records that `userId` verified in `guildId` from this network (per server since v12). */
export async function recordIpHash(guildId, userId, ipHash, { q = query } = {}) {
    await q(
        `INSERT INTO ${T.verificationGuildIps} (guild_id, user_id, ip_hash, seen_at) VALUES ($1, $2, $3, NOW())
         ON CONFLICT (guild_id, ip_hash, user_id) DO UPDATE SET seen_at = NOW()`,
        [guildId, userId, ipHash]
    );
}

/**
 * Other members seen on this network in this server (its scope, guardScope) who have an active
 * ban there: [{ user_id, case_code, target_username }]. Throws on a database error.
 */
export async function bannedOnSameNetwork(guildId, userId, ipHash, { q = query, config = enforcementConfig } = {}) {
    const scope = guardScope(guildId, config);
    if (!scope.guildIds.length) return [];
    const { rows } = await q(
        `WITH seen AS (
             SELECT user_id FROM ${T.verificationGuildIps} WHERE ip_hash = $1 AND user_id <> $2 AND guild_id = ANY($3)
             UNION
             SELECT user_id FROM ${T.verificationIps} WHERE $5 AND ip_hash = $1 AND user_id <> $2
         )
         SELECT DISTINCT ON (s.user_id) s.user_id, c.case_code, c.target_username
         FROM seen s
         JOIN ${T.cases} c ON c.target_user_id = s.user_id
         WHERE c.guild_id = ANY($3) AND c.type = 'ban' AND c.is_test = FALSE
           AND c.status = ANY($4) AND (c.expires_at IS NULL OR c.expires_at > NOW())
         ORDER BY s.user_id, c.created_at DESC
         LIMIT 5`,
        [ipHash, userId, scope.guildIds, OPEN_STATUSES, scope.legacy]
    );
    return rows;
}

/**
 * Records where this verification in `guildId` came from and decides whether staff must
 * approve it. Returns { hold: boolean, reasons: string[], items: object[] } (reasons: English, for
 * the log; items: the same reasons as data, so the staff card is written in its server's language).
 * Never throws: if the checks can't
 * run (no database), verification goes through as before.
 */
export async function assessVerification(guildId, userId, ip) {
    const reasons = [];
    const items = [];
    const age = accountAgeMs(userId);
    if (age < MIN_ACCOUNT_AGE_MS) {
        reasons.push(`Account is only ${formatDuration(Math.max(age, 60 * 1000))} old (minimum ${formatDuration(MIN_ACCOUNT_AGE_MS)})`);
        items.push({ kind: 'young', ageMs: Math.max(age, 60 * 1000), minMs: MIN_ACCOUNT_AGE_MS });
    }

    const ipHash = hashIp(ip);
    if (ipHash && guildId && isEnforcementDbAvailable()) {
        try {
            await pruneOldHashes();
            await recordIpHash(guildId, userId, ipHash);
            const matches = await bannedOnSameNetwork(guildId, userId, ipHash);
            for (const match of matches) {
                reasons.push(`Same network as banned member ${match.target_username} (\`${match.user_id}\`, ban \`${match.case_code}\`)`);
                items.push({ kind: 'network', username: match.target_username, userId: match.user_id, caseCode: match.case_code });
            }
        } catch (error) {
            logger.warn(`Verification network check failed for ${userId} in ${guildId}: ${error.message}`);
        }
    }
    return { hold: reasons.length > 0, reasons, items };
}

/** One reason of a held verification in `tr`'s language (items from assessVerification). */
export function holdReasonText(tr, item) {
    if (item.kind === 'young') {
        return tr.t('verification.hold.reasonYoung', { age: durationIn(item.ageMs, tr.lang), min: durationIn(item.minMs, tr.lang) });
    }
    return tr.t('verification.hold.reasonNetwork', { username: String(item.username ?? ''), userId: String(item.userId ?? ''), caseCode: String(item.caseCode ?? '') });
}

/**
 * Posts the Approve / Deny card for a held verification, in the language of the server the card
 * is posted in. `items` (from assessVerification) give the reasons in that language; without
 * them the English `reasons` are shown as given.
 */
export async function postVerificationHold(client, guildId, user, reasons, items = null) {
    const channel = await reviewChannel(client, guildId);
    if (!channel) {
        logger.warn(`Verification of ${user.id} held, but there is no review channel to ask staff in`);
        return false;
    }
    const tr = textForGuild(channel.guild?.id ?? guildId, { purpose: 'public' });
    const lines = Array.isArray(items) && items.length ? items.map((item) => holdReasonText(tr, item)) : reasons;
    await channel.send({
        embeds: [createEmbed({
            title: tr.t('verification.hold.title'),
            fields: [
                { name: tr.t('verification.hold.user'), value: `<@${user.id}> ${user.username} (\`${user.id}\`)`, inline: true },
                { name: tr.t('verification.hold.created'), value: dateStamp(new Date(SnowflakeUtil.timestampFrom(user.id))), inline: true },
                { name: tr.t('verification.hold.why'), value: truncate(lines.map((r) => `• ${r}`).join('\n'), 1024) },
            ],
            footer: { text: tr.t('verification.hold.footer') },
            color: STATUS_COLORS.waiting,
            timestamp: true,
        })],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`verifyreview:approve:${guildId}:${user.id}`).setLabel(tr.t('verification.hold.approve')).setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`verifyreview:deny:${guildId}:${user.id}`).setLabel(tr.t('verification.hold.deny')).setStyle(ButtonStyle.Danger),
        )],
        allowedMentions: { parse: [] },
    });
    return true;
}
