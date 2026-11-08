// automodReport.js — how automod did over a period: actions per rule, how often
// moderators undid or changed its decisions, accepted appeals, and the most frequent
// offenders. A rule with many undos is too strict or misfiring. Posted weekly in the
// alerts channel and shown by /automod stats.
//
// Multi-server (B1): posted per server, to that server's own alerts channel. Candidates are
// the main server plus the servers with automod cases in the period (one query, not one per
// server the bot is in); a server other than the main one must have automod on.

import { AUTOMOD_RULES } from '../../config/automod.js';
import { customGroupLabel } from './customRules.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { query, T, isEnforcementDbAvailable } from '../enforcement/db.js';
import { postModLog } from '../enforcement/enforcementService.js';
import { logger } from '../../utils/logger.js';
import { isSettingsUnavailable, noteSettingsUnavailable } from '../settings/guildScoped.js';
import { getAutomodSettings, isLegacyAutomodGuild } from './automodSettings.js';
import { staffGuildId } from './channelRouting.js';

// Servers one report run looks at, at most (B5: per-server cron limits).
export const REPORT_GUILDS_MAX = 5000;

const GROUP_LABELS = Object.values(AUTOMOD_RULES).reduce((labels, rule) => {
    labels[rule.group] = labels[rule.group] ? `${labels[rule.group]} / ${rule.label}` : rule.label;
    return labels;
}, { report: 'Member reports' });

/** { total, byGroup: [{ group, label, actions, undone, changed, appealed }], topOffenders: [{ userId, username, count }] } */
export async function automodStats(guildId, days = 7) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const [groups, offenders] = await Promise.all([
        query(
            `SELECT substring(c.reason_key from 9) AS grp,
                    COUNT(*)::int AS actions,
                    COUNT(*) FILTER (WHERE c.revoke_reason LIKE 'Automod decision reversed%')::int AS undone,
                    COUNT(*) FILTER (WHERE c.revoke_reason LIKE 'Automod decision changed%')::int AS changed,
                    COUNT(*) FILTER (WHERE c.revoke_reason LIKE 'Appeal accepted%')::int AS appealed
             FROM ${T.cases} c
             WHERE c.guild_id = $1 AND c.reason_key LIKE 'automod:%' AND c.is_test = FALSE AND c.voided_at IS NULL AND c.created_at >= $2
             GROUP BY grp ORDER BY actions DESC`,
            [guildId, since]
        ),
        query(
            `SELECT target_user_id AS user_id, MAX(target_username) AS username, COUNT(*)::int AS count
             FROM ${T.cases}
             WHERE guild_id = $1 AND reason_key LIKE 'automod:%' AND is_test = FALSE AND voided_at IS NULL AND created_at >= $2
             GROUP BY target_user_id ORDER BY count DESC LIMIT 5`,
            [guildId, since]
        ),
    ]);
    const byGroup = groups.rows.map((row) => ({ ...row, group: row.grp, label: GROUP_LABELS[row.grp] || customGroupLabel(row.grp) || row.grp }));
    return {
        days,
        total: byGroup.reduce((sum, row) => sum + row.actions, 0),
        byGroup,
        topOffenders: offenders.rows.map((row) => ({ userId: row.user_id, username: row.username, count: row.count })),
    };
}

export function formatAutomodStats(stats) {
    const rules = stats.byGroup.map((row) => {
        const corrected = row.undone + row.changed;
        const rate = row.actions ? Math.round((corrected / row.actions) * 100) : 0;
        return `**${row.label}:** ${row.actions} action(s)${corrected ? ` · ${row.undone} undone, ${row.changed} changed (${rate}%)${rate >= 30 ? ' · **often corrected**' : ''}` : ''}${row.appealed ? ` · ${row.appealed} appeal(s) accepted` : ''}`;
    });
    const offenders = stats.topOffenders.map((row) => `<@${row.userId}> ${row.username}: ${row.count}`);
    return {
        rules: rules.join('\n') || 'No automod actions.',
        offenders: offenders.join('\n') || 'None',
        footer: 'Often corrected = moderators corrected 30% or more of this rule\'s decisions, so it may be too strict.',
    };
}

/** Servers with automod cases since `sinceMs` ago. Throws on a database error. */
export async function guildsWithAutomodCases(sinceMs) {
    const { rows } = await query(
        `SELECT DISTINCT guild_id FROM ${T.cases}
         WHERE reason_key LIKE 'automod:%' AND is_test = FALSE AND created_at >= $1
         LIMIT ${REPORT_GUILDS_MAX}`,
        [new Date(Date.now() - sinceMs).toISOString()]
    );
    return rows.map((row) => row.guild_id);
}

/**
 * The servers a digest or report run posts for: the main server (as before) plus `candidates`,
 * each mapped to the server its staff posts go to (home servers share the main server's
 * channels, so they get one post), only servers the bot is in, and outside the main server
 * only where automod is on. A server whose settings can't be read is skipped this run.
 */
export async function reportGuilds(client, candidates = []) {
    const out = [];
    const seen = new Set();
    for (const id of [enforcementConfig.mainGuildId, ...candidates]) {
        if (!id) continue;
        const guildId = staffGuildId(id);
        if (seen.has(guildId) || !client.guilds.cache.has(guildId)) continue;
        seen.add(guildId);
        if (!isLegacyAutomodGuild(guildId)) {
            const on = await getAutomodSettings(guildId).then((s) => s.enabled).catch((error) => {
                if (isSettingsUnavailable(error)) noteSettingsUnavailable(guildId, 'automod report');
                else logger.warn(`Automod report: settings of ${guildId} unreadable (${error.message}); skipped`);
                return false;
            });
            if (!on) continue;
        }
        out.push(guildId);
        if (out.length >= REPORT_GUILDS_MAX) break;
    }
    return out;
}

/** Posts last week's automod numbers in each server's alerts channel. */
export async function postWeeklyAutomodReport(client) {
    if (!isEnforcementDbAvailable()) return;
    const guildIds = await reportGuilds(client, await guildsWithAutomodCases(7 * 24 * 60 * 60 * 1000));
    for (const guildId of guildIds) {
        try {
            await postWeeklyReportFor(client, guildId);
        } catch (error) {
            logger.warn(`Weekly automod report for ${guildId} failed: ${error.message}`);
        }
    }
}

async function postWeeklyReportFor(client, guildId) {
    const stats = await automodStats(guildId, 7);
    // Other servers: nothing to say, nothing posted (the main server keeps its weekly post).
    if (!stats.total && !isLegacyAutomodGuild(guildId)) return;
    const text = formatAutomodStats(stats);
    await postModLog(client, 'automod-report', [
        { name: `Last 7 days: ${stats.total} action(s)`, value: text.rules.slice(0, 1024) },
        { name: 'Most actions against', value: text.offenders.slice(0, 1024) },
        { name: 'Note', value: text.footer },
    ], { guildId, title: 'Weekly automod report' });
}
