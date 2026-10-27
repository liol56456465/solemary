// automodDigest.js — the daily automod digest in the alerts channel (08:00 UTC):
// automod actions per rule in the last 24 hours and how many moderators undid
// (a false-positive signal), hits per rule, busiest channels, open reviews and raids.
//
// Actions, undos and changes come from the case log (mod_cases, reason_key
// "automod:<group>", the same query as the weekly report). Individual hits, channels,
// open reviews and raids are not stored: they are counted in memory
// (reviewRegistry.js), so after a restart they only cover the time since startup.
// The footer says so.

import { AUTOMOD_RULES } from '../../config/automod.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { isEnforcementDbAvailable } from '../enforcement/db.js';
import { postModLog } from '../enforcement/enforcementService.js';
import { automodStats } from './automodReport.js';
import { eventsSince, hitsSince, openCards, startedAt as registryStartedAt } from './reviewRegistry.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const UNDO_WARN_RATE = 30;

function countBy(list, keyOf) {
    const counts = new Map();
    for (const item of list) {
        const key = keyOf(item);
        if (key) counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * Pure: the digest's text. input: { stats (automodStats for 1 day), hits [{ rule,
 * channelId, monitor }], openCount, raids, startedAt, now }.
 * Returns { fields, footer, empty }.
 */
export function buildDigest({ stats, hits = [], openCount = 0, raids = 0, startedAt = 0, now = Date.now() }) {
    const actionLines = (stats?.byGroup || []).map((row) => {
        const corrected = row.undone + row.changed;
        const rate = row.actions ? Math.round((corrected / row.actions) * 100) : 0;
        const undo = corrected ? ` · ${row.undone} undone${row.changed ? `, ${row.changed} changed` : ''} (${rate}%)${rate >= UNDO_WARN_RATE ? ' ⚠️' : ''}` : '';
        return `**${row.label}:** ${row.actions}${undo}`;
    });

    const byRule = countBy(hits, (hit) => hit.rule);
    const monitorByRule = new Map(countBy(hits.filter((hit) => hit.monitor), (hit) => hit.rule));
    const hitLines = byRule.map(([rule, count]) => {
        const monitor = monitorByRule.get(rule);
        return `${AUTOMOD_RULES[rule]?.label || rule}: ${count}${monitor ? ` (${monitor} in monitor mode)` : ''}`;
    });
    const channelLines = countBy(hits, (hit) => hit.channelId).slice(0, 5)
        .map(([channelId, count]) => `<#${channelId}>: ${count}`);

    const totalActions = stats?.total || 0;
    const fields = [
        { name: `Automod actions (24 h): ${totalActions}`, value: actionLines.join('\n') || 'None' },
        { name: `Hits per rule: ${hits.length}`, value: hitLines.join('\n') || 'None' },
        { name: 'Busiest channels', value: channelLines.join('\n') || 'None', inline: true },
        { name: 'Open reviews', value: openCount ? `${openCount} waiting · \`/automod queue\`` : 'None', inline: true },
        { name: 'Raids', value: raids ? `${raids} lockdown(s) started` : 'None', inline: true },
    ];

    const partial = now - startedAt < DAY_MS;
    const footer = [
        'Actions and undos: case log, last 24 h.',
        partial
            ? `Hits, channels, open reviews and raids: counted in memory since the bot started ${Math.max(1, Math.round((now - startedAt) / 3600000))} h ago.`
            : 'Hits, channels, open reviews and raids: counted in memory (a restart resets them).',
        `⚠️ = moderators corrected ${UNDO_WARN_RATE}% or more: the rule may be too strict.`,
    ].join(' ');

    return { fields, footer, empty: !totalActions && !hits.length && !openCount && !raids };
}

/** Posts yesterday's digest in the alerts channel; skipped on a day with nothing to say. */
export async function postDailyAutomodDigest(client) {
    if (!isEnforcementDbAvailable() || !client.guilds.cache.has(enforcementConfig.mainGuildId)) return;
    const now = Date.now();
    const since = now - DAY_MS;
    const stats = await automodStats(enforcementConfig.mainGuildId, 1);
    const digest = buildDigest({
        stats,
        hits: hitsSince(since),
        openCount: openCards().length,
        raids: eventsSince(since, 'raid').length,
        startedAt: registryStartedAt,
        now,
    });
    if (digest.empty) return;
    await postModLog(client, 'digest', digest.fields, { footer: { text: digest.footer } });
}
