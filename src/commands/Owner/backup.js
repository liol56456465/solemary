import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { isBotOwner } from '../../config/bot.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { backupSummary, getRestoreState, restoreMembers } from '../../services/memberBackupService.js';
import { getSnapshot, listSnapshots, rebuildFromSnapshot, takeSnapshot } from '../../services/structureBackupService.js';
import { dateStamp } from '../../services/enforcement/format.js';

function userError(message) {
    return new TitanBotError(message, ErrorTypes.USER_INPUT, message, { expected: true });
}

function isOwner(interaction) {
    const main = interaction.client.guilds.cache.get(enforcementConfig.mainGuildId);
    return isBotOwner(interaction.user.id) || main?.ownerId === interaction.user.id || interaction.guild?.ownerId === interaction.user.id;
}

async function handleStructure(interaction, client, sub) {
    const mainId = enforcementConfig.mainGuildId;
    if (sub === 'snapshot') {
        const main = client.guilds.cache.get(mainId);
        if (!main) throw userError('I cannot reach the main server.');
        const row = await takeSnapshot(main);
        return InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed('Snapshot saved', `#${row.id}: ${row.summary}`)] });
    }
    if (sub === 'snapshots') {
        const rows = await listSnapshots(mainId);
        return InteractionHelper.safeEditReply(interaction, {
            embeds: [createEmbed({
                title: 'Server snapshots',
                description: rows.length
                    ? `${rows.map((row) => `**#${row.id}** · ${dateStamp(row.created_at)} · ${row.summary}`).join('\n')}\n\nRebuild with \`/backup rebuild server_id:<id> snapshot:<number>\`.`
                    : 'No snapshots yet. One is taken every day, or now with `/backup snapshot`.',
                color: 'primary',
            })],
        });
    }

    const serverId = interaction.options.getString('server_id').trim();
    const target = client.guilds.cache.get(serverId);
    if (!target) throw userError('I am not in that server. Invite the bot there first, with Administrator.');
    if (serverId === mainId) throw userError('Rebuild creates the main server\'s structure in a *different* server.');
    if (!target.members.me?.permissions.has(PermissionFlagsBits.Administrator)) {
        throw userError(`Give me **Administrator** in ${target.name} first, so I can create roles and channels with their permissions.`);
    }
    const snapshot = await getSnapshot(mainId, interaction.options.getInteger('snapshot'));
    if (!snapshot) throw userError('No such snapshot. See `/backup snapshots`.');

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed('Rebuild started', `Creating ${snapshot.summary} from snapshot #${snapshot.id} in **${target.name}**. Existing roles and channels there are left alone.`)],
    });
    const owner = interaction.user;
    rebuildFromSnapshot(target, snapshot, (text) => interaction.editReply({ embeds: [successEmbed('Rebuild running', text)] }))
        .then(async (counts) => {
            const summary = `**Rebuild of ${target.name} finished:** ${counts.roles} roles and ${counts.channels} channels created, ${counts.failed} failed. Next: \`/backup restore server_id:${target.id}\` to bring the members.`;
            await interaction.editReply({ embeds: [successEmbed('Rebuild finished', summary)] }).catch(() => {});
            await owner.send({ content: summary, allowedMentions: { parse: [] } }).catch(() => {});
        })
        .catch(async (error) => {
            logger.error(`Rebuild into ${target.id} stopped: ${error.message}`);
            await owner.send({ content: `**Rebuild of ${target.name} stopped:** ${error.message}`, allowedMentions: { parse: [] } }).catch(() => {});
        });
}

export default {
    // Registered in the main and the support server, so it still works if the main one is gone.
    data: new SlashCommandBuilder()
        .setName('backup')
        .setDescription('Owner only: member and server-structure backups for recovering from a lost server')
        .addSubcommand((sub) => sub.setName('status').setDescription('How many members can be restored'))
        .addSubcommand((sub) => sub.setName('restore').setDescription('Add every restorable member to a server the bot is in')
            .addStringOption((option) => option.setName('server_id').setDescription('ID of the server to add them to').setRequired(true).setMinLength(17).setMaxLength(20)))
        .addSubcommand((sub) => sub.setName('snapshot').setDescription('Save the main server\'s roles and channels now (also done daily)'))
        .addSubcommand((sub) => sub.setName('snapshots').setDescription('List saved snapshots of the main server'))
        .addSubcommand((sub) => sub.setName('rebuild').setDescription('Recreate the main server\'s roles and channels in another server')
            .addStringOption((option) => option.setName('server_id').setDescription('ID of the new server').setRequired(true).setMinLength(17).setMaxLength(20))
            .addIntegerOption((option) => option.setName('snapshot').setDescription('Snapshot number (default: latest)').setMinValue(1))),

    async execute(interaction, config, client) {
        if (!isOwner(interaction)) {
            throw new TitanBotError('Not the owner', ErrorTypes.PERMISSION, 'Only the server owner can use /backup.', { expected: true });
        }
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        const sub = interaction.options.getSubcommand();
        if (sub === 'snapshot' || sub === 'snapshots' || sub === 'rebuild') {
            return handleStructure(interaction, client, sub);
        }

        if (sub === 'status') {
            const main = client.guilds.cache.get(enforcementConfig.mainGuildId);
            const { stored, inGuild } = await backupSummary(main);
            const state = getRestoreState();
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [createEmbed({
                    title: 'Member backup',
                    description: [
                        `**Restorable members:** ${stored} (verified with "Verify with Discord")`,
                        main ? `**Of them in the main server now:** ${inGuild}` : '**Main server:** not reachable',
                        state ? `**Restore running:** ${state.done}/${state.total} into \`${state.guildId}\`` : null,
                        '',
                        'Restore with `/backup restore server_id:<id>`. The bot must be in that server with **Create Invite**. Members with an active ban are skipped.',
                    ].filter((line) => line !== null).join('\n'),
                    color: 'primary',
                })],
            });
        }

        const serverId = interaction.options.getString('server_id').trim();
        const target = client.guilds.cache.get(serverId);
        if (!target) throw userError('I am not in that server. Invite the bot there first.');
        if (!target.members.me?.permissions.has(PermissionFlagsBits.CreateInstantInvite)) {
            throw userError(`I need the **Create Invite** permission in ${target.name} to add members.`);
        }
        if (getRestoreState()) throw userError('A restore is already running. Check `/backup status`.');

        const { stored } = await backupSummary(target);
        await InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed('Restore started', `Adding up to **${stored}** members to **${target.name}**. This message updates as it goes, and you get a DM when it is done.`)],
        });

        const owner = interaction.user;
        // Runs after the command returns; the reply can only be edited for 15 minutes, so the DM is the final word.
        restoreMembers(client, target, (text) => interaction.editReply({ embeds: [successEmbed('Restore running', text)] }))
            .then(async (counts) => {
                const summary = [
                    `**Member restore into ${target.name} finished.**`,
                    `Added: ${counts.added} · Already there: ${counts.already} · Skipped (active ban): ${counts.skippedBanned}`,
                    `No usable authorization: ${counts.noToken} · Failed: ${counts.failed} · Total: ${counts.total}`,
                ].join('\n');
                await interaction.editReply({ embeds: [successEmbed('Restore finished', summary)] }).catch(() => {});
                await owner.send({ content: summary, allowedMentions: { parse: [] } }).catch(() => {});
            })
            .catch(async (error) => {
                logger.error(`Member restore into ${target.id} stopped: ${error.message}`);
                await owner.send({ content: `**Member restore into ${target.name} stopped:** ${error.message}`, allowedMentions: { parse: [] } }).catch(() => {});
            });
    },
};
