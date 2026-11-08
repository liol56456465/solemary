// alertPost.js — staff alerts that carry buttons ("Show what changed" / "Revert" / "Lock down"
// on nuke alerts, "Release
// non-offenders" on raid reports). Same routing and look as postModLog
// (channelRouting.js), which has no components option.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { channelPurposeFor, fetchStaffChannel, resolveChannelId, staffGuildId } from './channelRouting.js';
import { isSettingsUnavailable } from '../settings/guildScoped.js';
import { clearPostFailures, recordPostFailure, recordSendError } from './postFailures.js';

/**
 * Posts an embed with components to the channel for `kind`. Returns the message or null.
 * `guildId`: the server the alert is about (home servers: the main server's channels; any
 * other server: only its own, skipped when not set).
 */
export async function postAlert(client, kind, {
    title, description = null, fields = [], color = 'error', components = [], guildId: sourceGuildId = enforcementConfig.mainGuildId,
}) {
    const purpose = channelPurposeFor(kind);
    const guildId = staffGuildId(sourceGuildId);
    const channel = await fetchStaffChannel(client, sourceGuildId, purpose);
    if (!channel) {
        // Recorded for the dashboard Overview (postFailures.js): not set, or gone / not text.
        // Server not in the cache (startup): not a channel problem, nothing to record.
        if (!client.guilds?.cache?.get(guildId)) return null;
        let channelId;
        try {
            channelId = resolveChannelId(sourceGuildId, purpose);
        } catch (error) {
            if (isSettingsUnavailable(error)) return null; // fetchStaffChannel logged it
            throw error;
        }
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

/**
 * "Show diff" for a nuke alert: compares the last snapshot before `at` of the server the nuke
 * happened in (`guildId`; the alert itself may be posted in another home server) with it now.
 */
export function showDiffRow(at = Date.now(), guildId = null) {
    const id = guildId ? `nukediff:${Math.floor(at / 1000)}:${guildId}` : `nukediff:${Math.floor(at / 1000)}`;
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(id).setLabel('Show what changed').setStyle(ButtonStyle.Secondary),
    );
}

/** A snowflake, or '0' (no offender known). */
const idOrZero = (id) => (/^\d{17,20}$/.test(String(id || '')) ? String(id) : '0');

/**
 * The nuke alert's buttons (any server with the staff guard on): "Show what changed" (the
 * server's Administrators), "Revert…" (its owner, or Administrators who are not the offender;
 * opens a confirm step) and "Lock down" (raid lockdown + panic pause, /automod lockdown-end
 * lifts it). `at`: when the nuke was detected; the diff uses the last snapshot before it, minus
 * a minute (a snapshot taken at the alert itself, snapshotIfStale, must not hide the damage).
 * `offenderId`: the member the guard acted on, refused by every button.
 */
export function nukeAlertRow(at, guildId, offenderId) {
    const seconds = Math.floor((at - 60_000) / 1000);
    const offender = idOrZero(offenderId);
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`nukediff:${seconds}:${guildId}:${offender}`).setLabel('Show what changed').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`nukerevert:ask:${seconds}:${guildId}:${offender}`).setLabel('Revert…').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`nukepanic:${guildId}:${offender}`).setLabel('Lock down (panic)').setStyle(ButtonStyle.Secondary),
    );
}
