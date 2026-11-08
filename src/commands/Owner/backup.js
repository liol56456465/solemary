import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { backupSummary, getRestoreState, restoreMembers, restoreRefusal } from '../../services/memberBackupService.js';
import {
    diffAgainstLive, getSnapshot, isBackupOwner, listSnapshots, rebuildFromSnapshot, takeSnapshot,
} from '../../services/structureBackupService.js';
import { diffPayload } from '../../handlers/backupRevert.js';
import { dateStamp } from '../../services/enforcement/format.js';
import { textForInteraction } from '../../utils/botText.js';
import { descriptionLocalizations } from '../../utils/commandLocalizations.js';

// Every reply is ephemeral and the DMs go to the owner who ran it: that person's Discord language.
// Progress lines from the backup services and their refusals stay as those services write them (English).

function userError(message) {
    return new TitanBotError(message, ErrorTypes.USER_INPUT, message, { expected: true });
}

// Bot owners (OWNER_IDS) or the main server's owner only. The owner of the server
// the command runs in doesn't count: that could be the support server's owner.
// If the main server is gone, only OWNER_IDS can restore, so keep it set.
function isOwner(interaction) {
    return isBackupOwner(interaction.client, interaction.user.id);
}

async function handleStructure(interaction, client, sub, tr) {
    const mainId = enforcementConfig.mainGuildId;
    if (sub === 'snapshot') {
        const main = client.guilds.cache.get(mainId);
        if (!main) throw userError(tr.t('owner.backup.noMain'));
        const row = await takeSnapshot(main);
        return InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed(tr.t('owner.backup.snapshotSavedTitle'), `#${row.id}: ${row.summary}`)] });
    }
    if (sub === 'changes' || sub === 'revert') {
        // Undo the nuke: compare a snapshot with the live main server; revert asks to confirm first.
        const main = client.guilds.cache.get(mainId);
        if (!main) throw userError(tr.t('owner.backup.noMain'));
        const snapshot = await getSnapshot(mainId, interaction.options.getInteger('snapshot'));
        if (!snapshot) throw userError(tr.t('owner.backup.noSnapshot'));
        const payload = diffPayload(snapshot, diffAgainstLive(main, snapshot), { withButtons: sub === 'revert', lang: tr.lang });
        if (sub === 'revert' && payload.components.length) {
            payload.content = tr.t('owner.backup.revertConfirm');
        }
        return InteractionHelper.safeEditReply(interaction, payload);
    }
    if (sub === 'snapshots') {
        const rows = await listSnapshots(mainId);
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [createEmbed({
                title: tr.t('owner.backup.snapshotsTitle'),
                description: rows.length
                    ? `${rows.map((row) => `**#${row.id}** · ${dateStamp(row.created_at)} · ${row.summary}`).join('\n')}\n\n${tr.t('owner.backup.snapshotsHelp')}`.slice(0, 4096)
                    : tr.t('owner.backup.noSnapshots'),
                color: 'primary',
            })],
        });
    }

    const serverId = interaction.options.getString('server_id').trim();
    const target = client.guilds.cache.get(serverId);
    if (!target) throw userError(tr.t('owner.backup.notInServerAdmin'));
    if (serverId === mainId) throw userError(tr.t('owner.backup.rebuildDifferent'));
    if (!target.members.me?.permissions.has(PermissionFlagsBits.Administrator)) {
        throw userError(tr.t('owner.backup.needAdmin', { server: target.name }));
    }
    const snapshot = await getSnapshot(mainId, interaction.options.getInteger('snapshot'));
    if (!snapshot) throw userError(tr.t('owner.backup.noSnapshot'));

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(tr.t('owner.backup.rebuildStartedTitle'), tr.t('owner.backup.rebuildStarted', { summary: snapshot.summary, id: snapshot.id, server: target.name }))],
    });
    const owner = interaction.user;
    rebuildFromSnapshot(target, snapshot, (text) => interaction.editReply({ embeds: [successEmbed(tr.t('owner.backup.rebuildRunningTitle'), text)] }))
        .then(async (counts) => {
            const summary = tr.t('owner.backup.rebuildFinished', { server: target.name, roles: counts.roles, channels: counts.channels, failed: counts.failed, serverId: target.id });
            await interaction.editReply({ embeds: [successEmbed(tr.t('owner.backup.rebuildFinishedTitle'), summary)] }).catch(() => {});
            await owner.send({ content: summary, allowedMentions: { parse: [] } }).catch(() => {});
        })
        .catch(async (error) => {
            logger.error(`Rebuild into ${target.id} stopped: ${error.message}`);
            await owner.send({ content: tr.t('owner.backup.rebuildStopped', { server: target.name, error: error.message }).slice(0, 2000), allowedMentions: { parse: [] } }).catch(() => {});
        });
}

export default {
    // Registered in the main and the support server, so it still works if the main one is gone.
    data: new SlashCommandBuilder()
        .setName('backup')
        .setDescription('Owner only: member and server-structure backups for recovering from a lost server')
        .setDescriptionLocalizations(descriptionLocalizations('owner.backup.cmd.description'))
        .addSubcommand((sub) => sub.setName('status').setDescription('How many members can be restored').setDescriptionLocalizations(descriptionLocalizations('owner.backup.cmd.status')))
        .addSubcommand((sub) => sub.setName('restore').setDescription('Add every restorable member to a server the bot is in').setDescriptionLocalizations(descriptionLocalizations('owner.backup.cmd.restore'))
            .addStringOption((option) => option.setName('server_id').setDescription('ID of the server to add them to').setDescriptionLocalizations(descriptionLocalizations('owner.backup.cmd.restoreServer')).setRequired(true).setMinLength(17).setMaxLength(20)))
        .addSubcommand((sub) => sub.setName('snapshot').setDescription('Save the main server\'s roles and channels now (also done daily)').setDescriptionLocalizations(descriptionLocalizations('owner.backup.cmd.snapshot')))
        .addSubcommand((sub) => sub.setName('snapshots').setDescription('List saved snapshots of the main server').setDescriptionLocalizations(descriptionLocalizations('owner.backup.cmd.snapshots')))
        .addSubcommand((sub) => sub.setName('changes').setDescription('What changed in the main server since a snapshot (deleted roles/channels, permissions)').setDescriptionLocalizations(descriptionLocalizations('owner.backup.cmd.changes'))
            .addIntegerOption((option) => option.setName('snapshot').setDescription('Snapshot number (default: latest)').setDescriptionLocalizations(descriptionLocalizations('owner.backup.cmd.snapshotNumber')).setMinValue(1)))
        .addSubcommand((sub) => sub.setName('revert').setDescription('Undo a nuke: restore deleted roles/channels and permissions from a snapshot').setDescriptionLocalizations(descriptionLocalizations('owner.backup.cmd.revert'))
            .addIntegerOption((option) => option.setName('snapshot').setDescription('Snapshot number (default: latest)').setDescriptionLocalizations(descriptionLocalizations('owner.backup.cmd.snapshotNumber')).setMinValue(1)))
        .addSubcommand((sub) => sub.setName('rebuild').setDescription('Recreate the main server\'s roles and channels in another server').setDescriptionLocalizations(descriptionLocalizations('owner.backup.cmd.rebuild'))
            .addStringOption((option) => option.setName('server_id').setDescription('ID of the new server').setDescriptionLocalizations(descriptionLocalizations('owner.backup.cmd.rebuildServer')).setRequired(true).setMinLength(17).setMaxLength(20))
            .addIntegerOption((option) => option.setName('snapshot').setDescription('Snapshot number (default: latest)').setDescriptionLocalizations(descriptionLocalizations('owner.backup.cmd.snapshotNumber')).setMinValue(1))),

    async execute(interaction, config, client) {
        const tr = textForInteraction(interaction);
        if (!isOwner(interaction)) {
            throw new TitanBotError('Not the owner', ErrorTypes.PERMISSION, tr.t('owner.backup.ownerOnly'), { expected: true });
        }
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        const sub = interaction.options.getSubcommand();
        if (['snapshot', 'snapshots', 'rebuild', 'changes', 'revert'].includes(sub)) {
            return handleStructure(interaction, client, sub, tr);
        }

        if (sub === 'status') {
            const main = client.guilds.cache.get(enforcementConfig.mainGuildId);
            const { stored, inGuild } = await backupSummary(main);
            const state = getRestoreState();
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [createEmbed({
                    title: tr.t('owner.backup.statusTitle'),
                    description: [
                        tr.t('owner.backup.statusStored', { stored }),
                        main ? tr.t('owner.backup.statusInMain', { inGuild }) : tr.t('owner.backup.statusNoMain'),
                        state ? tr.t('owner.backup.statusRunning', { done: state.done, total: state.total, guildId: state.guildId }) : null,
                        '',
                        tr.t('owner.backup.statusHelp'),
                    ].filter((line) => line !== null).join('\n'),
                    color: 'primary',
                })],
            });
        }

        const serverId = interaction.options.getString('server_id').trim();
        const refusal = restoreRefusal(serverId);
        if (refusal) throw userError(refusal);
        const target = client.guilds.cache.get(serverId);
        if (!target) throw userError(tr.t('owner.backup.notInServer'));
        if (!target.members.me?.permissions.has(PermissionFlagsBits.CreateInstantInvite)) {
            throw userError(tr.t('owner.backup.needInvite', { server: target.name }));
        }
        if (getRestoreState()) throw userError(tr.t('owner.backup.restoreRunning'));

        const { stored } = await backupSummary(target);
        await InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(tr.t('owner.backup.restoreStartedTitle'), tr.t('owner.backup.restoreStarted', { stored, server: target.name }))],
        });

        const owner = interaction.user;
        // Runs after the command returns; the reply can only be edited for 15 minutes, so the DM is the final word.
        restoreMembers(client, target, (text) => interaction.editReply({ embeds: [successEmbed(tr.t('owner.backup.restoreRunningTitle'), text)] }))
            .then(async (counts) => {
                const summary = [
                    tr.t('owner.backup.restoreFinishedHead', { server: target.name }),
                    tr.t('owner.backup.restoreFinishedCounts', { added: counts.added, already: counts.already, skipped: counts.skippedBanned }),
                    tr.t('owner.backup.restoreFinishedMore', { noToken: counts.noToken, failed: counts.failed, total: counts.total }),
                ].join('\n');
                await interaction.editReply({ embeds: [successEmbed(tr.t('owner.backup.restoreFinishedTitle'), summary)] }).catch(() => {});
                await owner.send({ content: summary, allowedMentions: { parse: [] } }).catch(() => {});
            })
            .catch(async (error) => {
                logger.error(`Member restore into ${target.id} stopped: ${error.message}`);
                await owner.send({ content: tr.t('owner.backup.restoreStopped', { server: target.name, error: error.message }).slice(0, 2000), allowedMentions: { parse: [] } }).catch(() => {});
            });
    },
};
