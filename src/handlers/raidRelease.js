// raidRelease.js — "Release non-offenders" on a raid incident report (raidrelease:<incidentId>).
// Administrators of the incident's own server; works once per incident. The home pair is one staff:
// a support-server raid's report sits in the main server's alerts channel, so a main-server click
// releases in the support server (reviewCards.actingGuild: Administrator there too).
// For every raid joiner with no case since the raid began: the automod extra-watch period is ended
// and an open join-gate flag line is closed as released. The result is posted to the
// alerts channel and the button is disabled.
// Language (utils/botText.js): the ephemeral answer in the clicker's Discord language; the mod-log
// post, the closed flag lines and the button in the staff server's language.

import { MessageFlags } from 'discord.js';
import { successEmbed } from '../utils/embeds.js';
import { ErrorTypes, replyUserError } from '../utils/errorHandler.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { logger } from '../utils/logger.js';
import { textForGuild, textForInteraction } from '../utils/botText.js';
import { isAdministrator, postModLog } from '../services/enforcement/enforcementService.js';
import { endProbation } from '../services/automod/probationService.js';
import { clearGateFlag, closeGateLine, getGateFlag } from '../services/automod/joinGate.js';
import { actingGuild } from '../services/automod/reviewCards.js';
import { staffGuildId } from '../services/automod/channelRouting.js';
import {
    casesAgainst, claimRelease, formatReleaseResult, getIncident, releaseRow, saveReleaseResult, splitOffenders,
} from '../services/automod/raidIncidentService.js';

async function closeFlag(guild, userId, by) {
    const flag = await getGateFlag(guild.id, userId);
    if (!flag) return false;
    // The flag line is in the staff server's review channel (the main server for a support joiner).
    const lineGuild = guild.client?.guilds?.cache?.get(staffGuildId(guild.id)) || guild;
    const channel = lineGuild.channels.cache.get(flag.channelId) || await lineGuild.channels.fetch(flag.channelId).catch(() => null);
    const message = channel?.isTextBased?.() ? await channel.messages.fetch(flag.messageId).catch(() => null) : null;
    if (message) {
        const line = textForGuild(lineGuild.id, { purpose: 'public' });
        await closeGateLine(message, line.t('automod.joinGate.outcome.released', { name: by }), { kicked: false, lang: line.lang });
    }
    await clearGateFlag(guild.id, userId);
    return true;
}

export async function handleRaidRelease(interaction, client, args) {
    const id = args[0];
    if (!/^\d+$/.test(id || '')) return;
    const tr = textForInteraction(interaction);
    // Any server: the incident must be this server's own (checked below).
    if (!interaction.guildId || !isAdministrator(interaction.member)) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('automod.raid.reply.adminOnly') });
    }
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    // The report (and its button) is in this server's alerts channel: its language.
    const post = textForGuild(interaction.guildId, { purpose: 'public' });

    const incident = await getIncident(id);
    if (!incident) {
        return InteractionHelper.safeEditReply(interaction, { content: tr.t('automod.raid.reply.gone') });
    }
    // This server's own incident, or (home pair) the other home server's, with Administrator there.
    let guild;
    try {
        ({ guild } = await actingGuild(interaction, incident.guild_id));
    } catch (error) {
        return InteractionHelper.safeEditReply(interaction, { content: error.userMessage || tr.t('automod.raid.reply.otherServer') });
    }
    const claimed = await claimRelease(id, interaction.user.id);
    if (!claimed) {
        await interaction.message.edit({ components: [releaseRow(id, true, { lang: post.lang })] }).catch(() => {});
        return InteractionHelper.safeEditReply(interaction, {
            content: incident.released_by ? tr.t('automod.raid.reply.alreadyBy', { userId: incident.released_by }) : tr.t('automod.raid.reply.already'),
            allowedMentions: { parse: [] },
        });
    }

    const joiners = claimed.joiner_ids || [];
    const cases = await casesAgainst(guild.id, joiners, claimed.started_at);
    const { offenders, clean } = splitOffenders(joiners, cases);
    const result = { clean: clean.length, offenders: offenders.size, probationEnded: 0, flagsCleared: 0, notInServer: 0 };
    const by = interaction.user.username;
    for (const userId of clean) {
        if (!guild.members.cache.has(userId)) result.notInServer += 1;
        try {
            if (await endProbation(guild.id, userId)) result.probationEnded += 1;
            if (await closeFlag(guild, userId, by)) result.flagsCleared += 1;
        } catch (error) {
            logger.warn(`Raid release of ${userId} failed: ${error.message}`);
        }
    }
    await saveReleaseResult(id, result).catch((error) => logger.warn(`Could not save raid release result: ${error.message}`));

    await interaction.message.edit({ components: [releaseRow(id, true, { lang: post.lang })] }).catch(() => {});
    // The mod log is in the staff server of the incident's server: its language.
    const log = textForGuild(staffGuildId(guild.id), { purpose: 'public' });
    await postModLog(client, 'raid', [
        { name: log.t('automod.raid.release.releasedBy'), value: `${by} (${interaction.user.id})` },
        { name: log.t('automod.raid.release.result'), value: formatReleaseResult(result, { lang: log.lang }) },
    ], { guildId: guild.id, title: log.t('automod.raid.release.title') });
    return InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed(tr.t('automod.raid.release.title'), formatReleaseResult(result, { lang: tr.lang }))] });
}
