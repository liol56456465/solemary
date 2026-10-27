// automodReport.js — how automod did over a period: actions per rule, how often
// moderators undid or changed its decisions, accepted appeals, and the most frequent
// offenders. A rule with many undos is too strict or misfiring. Posted weekly in the
// alerts channel and shown by /automod stats.

import { AUTOMOD_RULES } from '../../config/automod.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { query, T, isEnforcementDbAvailable } from '../enforcement/db.js';
import { postModLog } from '../enforcement/enforcementService.js';

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
    const byGroup = groups.rows.map((row) => ({ ...row, group: row.grp, label: GROUP_LABELS[row.grp] || row.grp }));
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
        return `**${row.label}:** ${row.actions} action(s)${corrected ? ` · ${row.undone} undone, ${row.changed} changed (${rate}%)${rate >= 30 ? ' ⚠️' : ''}` : ''}${row.appealed ? ` · ${row.appealed} appeal(s) accepted` : ''}`;
    });
    const offenders = stats.topOffenders.map((row) => `<@${row.userId}> ${row.username}: ${row.count}`);
    return {
        rules: rules.join('\n') || 'No automod actions.',
        offenders: offenders.join('\n') || 'None',
        footer: '⚠️ = moderators corrected 30% or more of this rule\'s decisions: it may be too strict.',
    };
}

/** Posts last week's automod numbers in the alerts channel. */
export async function postWeeklyAutomodReport(client) {
    if (!isEnforcementDbAvailable() || !client.guilds.cache.has(enforcementConfig.mainGuildId)) return;
    const stats = await automodStats(enforcementConfig.mainGuildId, 7);
    const text = formatAutomodStats(stats);
    await postModLog(client, 'automod-report', [
        { name: `Last 7 days: ${stats.total} action(s)`, value: text.rules.slice(0, 1024) },
        { name: 'Most actions against', value: text.offenders.slice(0, 1024) },
        { name: 'Note', value: text.footer },
    ], { title: '📊 Weekly automod report' });
}
