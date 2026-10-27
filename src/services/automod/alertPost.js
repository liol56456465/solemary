// alertPost.js — staff alerts that carry buttons ("Show diff" on nuke alerts, "Release
// non-offenders" on raid reports). Same routing and look as postModLog
// (channelRouting.js), which has no components option.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { channelPurposeFor, fetchStaffChannel } from './channelRouting.js';

/** Posts an embed with components to the channel for `kind`. Returns the message or null. */
export async function postAlert(client, kind, { title, description = null, fields = [], color = 'error', components = [] }) {
    const purpose = channelPurposeFor(kind);
    const channel = await fetchStaffChannel(client, purpose);
    if (!channel) return null;
    return channel.send({
        embeds: [createEmbed({ title, description, fields, color, timestamp: true })],
        components,
        allowedMentions: { parse: [] },
    }).catch((error) => {
        logger.warn(`Staff ${purpose} post failed: ${error.message}`);
        return null;
    });
}

/** "Show diff" for a nuke alert: compares the last snapshot before `at` with the server now. */
export function showDiffRow(at = Date.now()) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`nukediff:${Math.floor(at / 1000)}`).setLabel('Show diff').setEmoji('🔍').setStyle(ButtonStyle.Secondary),
    );
}
