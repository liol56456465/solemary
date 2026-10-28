// secondOpinion.js — spot checks on kept automod decisions. When an admin presses
// Keep on a full review card, about secondOpinionRate of the time the bot replies to
// the card in the review channel: "Kept by @A — a second admin can confirm or undo",
// with Confirm / Undo buttons that refuse the admin who kept it. Nobody is pinged.
// The outcome is recorded on the request and on the original card; Undo uses the
// normal review undo path (reviewCards.js).

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { automodConfig } from '../../config/automod.js';
import { createEmbed } from '../../utils/embeds.js';

const CUSTOM_ID_MAX = 100;

/** Whether this keep gets a second-opinion request. `rand` is for tests. */
export function shouldAskSecondOpinion(rate = automodConfig.secondOpinionRate, rand = Math.random()) {
    return rate > 0 && rand < rate;
}

/** The admin who kept a card cannot give its second opinion. */
export function canGiveSecondOpinion(userId, keeperId) {
    return Boolean(userId) && userId !== keeperId;
}

/** The newest case codes that fit in a custom id after `prefix`, comma-separated. */
export function fitCodes(codes, prefix) {
    const room = CUSTOM_ID_MAX - prefix.length;
    const kept = [];
    for (const code of [...codes].reverse()) {
        const next = [code, ...kept].join(',');
        if (next.length > room) break;
        kept.unshift(code);
    }
    return kept.join(',');
}

export function secondOpinionPayload(keeperId, codes, cardUrl = null) {
    const confirmPrefix = `amreview:2nd:confirm:${keeperId}:`;
    const undoPrefix = `amreview:2nd:undo:${keeperId}:`;
    const buttonCodes = fitCodes(codes, confirmPrefix); // the longer prefix: fits both
    const shown = buttonCodes.split(',').filter(Boolean);
    const omitted = codes.length - shown.length;
    const embed = createEmbed({
        title: '🤝 Second opinion?',
        description: [
            `Kept by <@${keeperId}> — a second admin can confirm or undo.`,
            `Case${shown.length > 1 ? 's' : ''}: ${shown.map((c) => `\`${c}\``).join(' ')}${omitted > 0 ? ` (+${omitted} older, use \`/case\`)` : ''}`,
            cardUrl ? `[Open the card](${cardUrl})` : null,
        ].filter(Boolean).join('\n'),
        color: 'info',
        footer: { text: `Random spot check (${Math.round(automodConfig.secondOpinionRate * 100)}% of kept cards)` },
    });
    return {
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`${confirmPrefix}${buttonCodes}`).setLabel('Confirm').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`${undoPrefix}${buttonCodes}`).setLabel('Undo').setStyle(ButtonStyle.Danger),
        )],
    };
}
