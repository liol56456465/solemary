// alertPost.js — staff alerts that carry buttons ("Show diff" on nuke alerts, "Release
// non-offenders" on raid reports). Same routing and look as postModLog
// (channelRouting.js), which has no components option.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { channelPurposeFor, fetchStaffChannel, resolveChannelId } from './channelRouting.js';
import { clearPostFailures, recordPostFailure, recordSendError } from './postFailures.js';

/** Posts an embed with components to the channel for `kind`. Returns the message or null. */
export async function postAlert(client, kind, { title, description = null, fields = [], color = 'error', components = [] }) {
    const purpose = channelPurposeFor(kind);
    const guildId = enforcementConfig.mainGuildId;
    const channel = await fetchStaffChannel(client, purpose);
    if (!channel) {
        // Recorded for the dashboard Overview (postFailures.js): not set, or gone / not text.
        // Main server not in the cache (startup): not a channel problem, nothing to record.
        if (!client.guilds?.cache?.get(guildId)) return null;
        const channelId = resolveChannelId(purpose);
        recordPostFailure({ guildId, purpose, channelId, reason: channelId ? 'missing' : 'notSet' });
        return null;
    }
    return channel.send({
        embeds: [createEmbed({ title, description, fields, color, timestamp: true })],
        components,
        allowedMentions: { parse: [] },
    }).then((message) => {
        clearPostFailures(guildId, purpose);
        return message;
    }, (error) => {
        logger.warn(`Staff ${purpose} post failed: ${error.message}`);
        recordSendError({ guildId, purpose, channel, error });
        return null;
    });
}

/** "Show diff" for a nuke alert: compares the last snapshot before `at` with the server now. */
export function showDiffRow(at = Date.now()) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`nukediff:${Math.floor(at / 1000)}`).setLabel('Show diff').setStyle(ButtonStyle.Secondary),
    );
}
