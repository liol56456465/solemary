// backupRevert.js — "undo the nuke" buttons.
//   nukediff:<epochSeconds>          "Show diff" on a staff-guard alert: the last snapshot taken
//                                     before the alert vs the server now. Admins and owners;
//                                     owners also get the Revert / Cancel buttons.
//   backuprevert:<confirm|cancel>:<snapshotId>   the confirm step of /backup revert. Owners only.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { enforcementConfig } from '../config/enforcement.js';
import { createEmbed, successEmbed } from '../utils/embeds.js';
import { ErrorTypes, replyUserError } from '../utils/errorHandler.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { logger } from '../utils/logger.js';
import { isAdministrator, postModLog } from '../services/enforcement/enforcementService.js';
import { dateStamp } from '../services/enforcement/format.js';
import {
    diffAgainstLive, diffHasChanges, formatDiff, formatRevertSummary, getSnapshot, getSnapshotBefore,
    isBackupOwner, revertToSnapshot,
} from '../services/structureBackupService.js';

/** The diff embed, with Revert / Cancel buttons when `withButtons` and there is something to revert. */
export function diffPayload(snapshot, diff, { withButtons = false } = {}) {
    const changes = diffHasChanges(diff);
    const embed = createEmbed({
        title: `Snapshot #${snapshot.id} vs the server now`,
        description: changes
            ? formatDiff(diff)
            : `${formatDiff(diff)}\nIf this snapshot was taken after the damage, pick an older one from \`/backup snapshots\`.`,
        footer: { text: `Snapshot taken ${new Date(snapshot.created_at).toISOString().slice(0, 16).replace('T', ' ')} UTC · ${snapshot.summary}` },
        color: changes ? 'warning' : 'success',
    });
    const components = withButtons && changes ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`backuprevert:confirm:${snapshot.id}`).setLabel('Revert to this snapshot').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`backuprevert:cancel:${snapshot.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    )] : [];
    return { embeds: [embed], components };
}

export async function handleNukeDiff(interaction, client, args) {
    const seconds = Number(args[0]);
    const owner = isBackupOwner(client, interaction.user.id);
    if (!owner && (interaction.guildId !== enforcementConfig.mainGuildId || !isAdministrator(interaction.member))) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'Only administrators can see the diff.' });
    }
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    const guild = client.guilds.cache.get(enforcementConfig.mainGuildId);
    if (!guild) return InteractionHelper.safeEditReply(interaction, { content: 'I cannot reach the main server.' });
    const before = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
    const snapshot = await getSnapshotBefore(guild.id, before);
    if (!snapshot) {
        return InteractionHelper.safeEditReply(interaction, { content: 'There is no snapshot from before this alert, so there is nothing to compare with.' });
    }
    const payload = diffPayload(snapshot, diffAgainstLive(guild, snapshot), { withButtons: owner });
    if (!owner) payload.embeds[0].setFooter({ text: 'Only the owner can revert (/backup revert).' });
    return InteractionHelper.safeEditReply(interaction, payload);
}

export async function handleBackupRevert(interaction, client, args) {
    const [decision, idText] = args;
    if (!isBackupOwner(client, interaction.user.id)) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'Only the server owner can revert the server structure.' });
    }
    if (decision === 'cancel') {
        return interaction.update({ embeds: [createEmbed({ title: 'Revert cancelled', description: 'Nothing was changed.', color: 'secondary' })], components: [] });
    }
    if (decision !== 'confirm' || !/^\d+$/.test(idText || '')) return;

    const guild = client.guilds.cache.get(enforcementConfig.mainGuildId);
    const snapshot = guild ? await getSnapshot(guild.id, idText) : null;
    if (!snapshot) {
        return interaction.update({ embeds: [createEmbed({ title: 'Revert not started', description: 'That snapshot (or the main server) is gone.', color: 'error' })], components: [] });
    }
    await interaction.update({
        embeds: [successEmbed('Revert running', `Restoring the main server from snapshot #${snapshot.id} (${dateStamp(snapshot.created_at)}). This message updates as it goes, and you get a DM when it is done.`)],
        components: [],
    });

    const owner = interaction.user;
    revertToSnapshot(guild, snapshot, (text) => interaction.editReply({ embeds: [successEmbed('Revert running', text)] }))
        .then(async (counts) => {
            const summary = formatRevertSummary(counts);
            await interaction.editReply({ embeds: [successEmbed('Revert finished', summary)] }).catch(() => {});
            await owner.send({ content: `**Revert of ${guild.name} finished:** ${summary}`, allowedMentions: { parse: [] } }).catch(() => {});
            await postModLog(client, 'revert', [
                { name: 'Snapshot', value: `#${snapshot.id} (${dateStamp(snapshot.created_at)})` },
                { name: 'By', value: `${owner.username} (${owner.id})` },
                { name: 'Result', value: summary.slice(0, 1024) },
            ]);
        })
        .catch(async (error) => {
            logger.error(`Revert of ${guild.id} stopped: ${error.message}`);
            await interaction.editReply({ embeds: [createEmbed({ title: 'Revert stopped', description: error.message, color: 'error' })] }).catch(() => {});
            await owner.send({ content: `**Revert of ${guild.name} stopped:** ${error.message}`, allowedMentions: { parse: [] } }).catch(() => {});
        });
}
