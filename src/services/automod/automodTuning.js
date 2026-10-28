// automodTuning.js — self-tuning from staff feedback. Runs with the daily digest:
// a rule whose automatic decisions moderators often undo or change (the same undo
// signal as the digest and /automod stats, per rule over tuningWindowDays) gets a
// suggestion in the alerts channel with a button that switches it to monitor mode.
// Each rule is suggested at most once per tuningCooldownMs; the last time is kept in
// the key-value store (automod:tuning:<guildId>, rule → epoch ms).
//
// The button (amreview:tune:<rule>) goes through the review-card handler, which
// checks again on click that the member is an administrator in the main server.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { AUTOMOD_RULES, automodConfig } from '../../config/automod.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { createEmbed } from '../../utils/embeds.js';
import { db, getFromDb } from '../../utils/database.js';
import { logger } from '../../utils/logger.js';
import { query, T } from '../enforcement/db.js';
import { getAutomodSettings, updateAutomodSettings } from './automodSettings.js';
import { fetchStaffChannel } from './channelRouting.js';
import { aggregateRuleStats, formatTuningSuggestion, ruleMode, tuningSuggestions } from './policy.js';

const tuningKey = (guildId) => `automod:tuning:${guildId}`;

/** Automod actions, undos and changes per rule over the last `days` (throws on a DB error). */
export async function automodRuleStats(guildId, days = automodConfig.tuningWindowDays) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { rows } = await query(
        `SELECT c.reason_key, split_part(c.reason, ' (', 1) AS reason_base,
                COUNT(*)::int AS actions,
                COUNT(*) FILTER (WHERE c.revoke_reason LIKE 'Automod decision reversed%')::int AS undone,
                COUNT(*) FILTER (WHERE c.revoke_reason LIKE 'Automod decision changed%')::int AS changed
         FROM ${T.cases} c
         WHERE c.guild_id = $1 AND c.reason_key LIKE 'automod:%' AND c.is_test = FALSE AND c.voided_at IS NULL AND c.created_at >= $2
         GROUP BY c.reason_key, reason_base`,
        [guildId, since]
    );
    return aggregateRuleStats(rows.map((row) => ({
        reasonKey: row.reason_key, reason: row.reason_base, actions: row.actions, undone: row.undone, changed: row.changed,
    })));
}

export function tuningComponents(rule) {
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`amreview:tune:${rule}`)
            .setLabel(`Switch ${AUTOMOD_RULES[rule]?.label || rule} to monitor`.slice(0, 80)).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('amreview:dismiss').setLabel('Dismiss').setStyle(ButtonStyle.Secondary),
    )];
}

/**
 * Claims a rule for this week's suggestion under the row lock: true when it was not
 * suggested within the cooldown (and is now marked), false otherwise.
 */
async function claimSuggestion(guildId, rule, now) {
    let claimed = false;
    await db.update(tuningKey(guildId), (current) => {
        const state = current && typeof current === 'object' ? { ...current } : {};
        if (now - (Number(state[rule]) || 0) < automodConfig.tuningCooldownMs) return state;
        claimed = true;
        state[rule] = now;
        return state;
    }, {});
    return claimed;
}

/** Posts this run's suggestions in the alerts channel. Returns how many were posted. */
export async function postTuningSuggestions(client, now = Date.now()) {
    const guildId = enforcementConfig.mainGuildId;
    const [byRule, settings, lastSuggested] = await Promise.all([
        automodRuleStats(guildId),
        getAutomodSettings(guildId),
        getFromDb(tuningKey(guildId), {}),
    ]);
    const suggestions = tuningSuggestions(byRule, { settings, lastSuggested, now });
    if (!suggestions.length) return 0;
    const channel = await fetchStaffChannel(client, 'alerts');
    if (!channel) {
        logger.warn(`Automod tuning: ${suggestions.length} suggestion(s) not posted (no alerts channel)`);
        return 0;
    }
    let posted = 0;
    for (const suggestion of suggestions) {
        if (!await claimSuggestion(guildId, suggestion.rule, now)) continue;
        const sent = await channel.send({
            embeds: [createEmbed({
                title: '🎛️ Automod tuning suggestion',
                description: [
                    `**${formatTuningSuggestion(suggestion)}**`,
                    `Moderators reversed or changed ${Math.round(suggestion.rate * 100)}% of this rule's automatic decisions. In monitor mode it only posts review cards; nothing is deleted or punished until someone applies it.`,
                    'Change it back any time with `/automod rule`.',
                ].join('\n'),
                color: 'warning',
                footer: { text: `Suggested at most once a week per rule · ${automodConfig.tuningWindowDays}-day case log` },
            })],
            components: tuningComponents(suggestion.rule),
            allowedMentions: { parse: [] },
        }).catch((error) => {
            logger.warn(`Automod tuning suggestion for ${suggestion.rule} failed: ${error.message}`);
            return null;
        });
        if (sent) posted += 1;
    }
    return posted;
}

/** The tuning button: switches the rule to monitor. Returns the confirmation text. */
export async function switchRuleToMonitor(guildId, rule) {
    if (!AUTOMOD_RULES[rule]) return { changed: false, text: 'That rule no longer exists.' };
    const before = ruleMode(await getAutomodSettings(guildId), rule);
    if (before === 'monitor' || before === 'off') {
        return { changed: false, text: `${AUTOMOD_RULES[rule].label} is already ${before}.` };
    }
    await updateAutomodSettings(guildId, (current) => ({ ...current, ruleModes: { ...current.ruleModes, [rule]: 'monitor' } }));
    return { changed: true, text: `${AUTOMOD_RULES[rule].label} is now in monitor mode.` };
}
