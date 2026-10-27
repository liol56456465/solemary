import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { isBotOwner } from '../../config/bot.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { backupSummary, getRestoreState, restoreMembers } from '../../services/memberBackupService.js';

function userError(message) {
    return new TitanBotError(message, ErrorTypes.USER_INPUT, message, { expected: true });
}

function isOwner(interaction) {
    const main = interaction.client.guilds.cache.get(enforcementConfig.mainGuildId);
    return isBotOwner(interaction.user.id) || main?.ownerId === interaction.user.id || interaction.guild?.ownerId === interaction.user.id;
}

export default {
    // Registered in the main and the support server, so it still works if the main one is gone.
    data: new SlashCommandBuilder()
        .setName('backup')
        .setDescription('Owner only: re-add verified members to a server with their stored authorization')
        .addSubcommand((sub) => sub.setName('status').setDescription('How many members can be restored'))
        .addSubcommand((sub) => sub.setName('restore').setDescription('Add every restorable member to a server the bot is in')
            .addStringOption((option) => option.setName('server_id').setDescription('ID of the server to add them to').setRequired(true).setMinLength(17).setMaxLength(20))),

    async execute(interaction, config, client) {
        if (!isOwner(interaction)) {
            throw new TitanBotError('Not the owner', ErrorTypes.PERMISSION, 'Only the server owner can use /backup.', { expected: true });
        }
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        if (interaction.options.getSubcommand() === 'status') {
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
