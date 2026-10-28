// verificationGuard.js — extra checks before OAuth verification gives the role.
//
// A verification is held for staff instead of going through when:
//   - the Discord account is younger than MIN_ACCOUNT_AGE_MS, or
//   - it comes from the same network (IP hash) as a member with an active ban in the
//     main server: a likely ban-evasion alt.
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

const DAY = 24 * 60 * 60 * 1000;
export const MIN_ACCOUNT_AGE_MS = 7 * DAY;
const IP_RETENTION_MS = 60 * DAY;
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

async function pruneOldHashes() {
    const now = Date.now();
    if (now - lastPrune < PRUNE_INTERVAL_MS) return;
    lastPrune = now;
    await query(
        `DELETE FROM ${T.verificationIps} v
         WHERE v.seen_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
           AND NOT EXISTS (
               SELECT 1 FROM ${T.cases} c
               WHERE c.target_user_id = v.user_id AND c.guild_id = $2 AND c.type = 'ban' AND c.is_test = FALSE
                 AND c.status = ANY($3) AND (c.expires_at IS NULL OR c.expires_at > NOW())
           )`,
        [IP_RETENTION_MS, enforcementConfig.mainGuildId, OPEN_STATUSES]
    ).catch((error) => logger.warn(`Could not prune verification IP hashes: ${error.message}`));
}

async function recordIpHash(userId, ipHash) {
    await query(
        `INSERT INTO ${T.verificationIps} (user_id, ip_hash, seen_at) VALUES ($1, $2, NOW())
         ON CONFLICT (user_id, ip_hash) DO UPDATE SET seen_at = NOW()`,
        [userId, ipHash]
    );
}

/** Other members seen on this network who have an active ban: [{ user_id, case_code, target_username }]. */
async function bannedOnSameNetwork(userId, ipHash) {
    const { rows } = await query(
        `SELECT DISTINCT ON (v.user_id) v.user_id, c.case_code, c.target_username
         FROM ${T.verificationIps} v
         JOIN ${T.cases} c ON c.target_user_id = v.user_id
         WHERE v.ip_hash = $1 AND v.user_id <> $2
           AND c.guild_id = $3 AND c.type = 'ban' AND c.is_test = FALSE
           AND c.status = ANY($4) AND (c.expires_at IS NULL OR c.expires_at > NOW())
         ORDER BY v.user_id, c.created_at DESC
         LIMIT 5`,
        [ipHash, userId, enforcementConfig.mainGuildId, OPEN_STATUSES]
    );
    return rows;
}

/**
 * Records where this verification came from and decides whether staff must approve it.
 * Returns { hold: boolean, reasons: string[] }. Never throws: if the checks can't run
 * (no database), verification goes through as before.
 */
export async function assessVerification(userId, ip) {
    const reasons = [];
    const age = accountAgeMs(userId);
    if (age < MIN_ACCOUNT_AGE_MS) {
        reasons.push(`Account is only ${formatDuration(Math.max(age, 60 * 1000))} old (minimum ${formatDuration(MIN_ACCOUNT_AGE_MS)})`);
    }

    const ipHash = hashIp(ip);
    if (ipHash && isEnforcementDbAvailable()) {
        try {
            await pruneOldHashes();
            await recordIpHash(userId, ipHash);
            const matches = await bannedOnSameNetwork(userId, ipHash);
            for (const match of matches) {
                reasons.push(`Same network as banned member ${match.target_username} (\`${match.user_id}\`, ban \`${match.case_code}\`)`);
            }
        } catch (error) {
            logger.warn(`Verification network check failed for ${userId}: ${error.message}`);
        }
    }
    return { hold: reasons.length > 0, reasons };
}

/** Posts the Approve / Deny card for a held verification. */
export async function postVerificationHold(client, guildId, user, reasons) {
    const channel = await reviewChannel(client);
    if (!channel) {
        logger.warn(`Verification of ${user.id} held, but there is no review channel to ask staff in`);
        return false;
    }
    await channel.send({
        embeds: [createEmbed({
            title: 'Verification needs approval',
            fields: [
                { name: 'User', value: `<@${user.id}> ${user.username} (\`${user.id}\`)`, inline: true },
                { name: 'Account created', value: dateStamp(new Date(SnowflakeUtil.timestampFrom(user.id))), inline: true },
                { name: 'Why it was held', value: truncate(reasons.map((r) => `• ${r}`).join('\n'), 1024) },
            ],
            footer: { text: 'Approve gives the verified role. Deny leaves them unverified and tells them by DM.' },
            color: STATUS_COLORS.waiting,
            timestamp: true,
        })],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`verifyreview:approve:${guildId}:${user.id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`verifyreview:deny:${guildId}:${user.id}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
        )],
        allowedMentions: { parse: [] },
    });
    return true;
}
