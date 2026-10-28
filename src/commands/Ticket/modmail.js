import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { getGuildConfig } from '../../services/config/guildConfig.js';
import {
    closeModmail, findModmailChannel, isModmailStaff, modmailUserId, setModmailBlocked,
} from '../../services/modmailService.js';

// /modmail close is for staff (checked here); block/unblock are admin-only (commandAccess.js).
export default {
    scope: 'main',
    data: new SlashCommandBuilder()
        .setName('modmail')
        .setDescription('Manage modmail conversations (members DM the bot to reach staff)')
        .addSubcommand((sub) => sub.setName('close').setDescription('Close this modmail conversation')
            .addStringOption((option) => option.setName('reason').setDescription('Sent to the member').setMaxLength(500)))
        .addSubcommand((sub) => sub.setName('block').setDescription('Stop a member from using modmail')
            .addUserOption((option) => option.setName('user').setDescription('Member to block').setRequired(true)))
        .addSubcommand((sub) => sub.setName('unblock').setDescription('Let a blocked member use modmail again')
            .addUserOption((option) => option.setName('user').setDescription('Member to unblock').setRequired(true)))
        .setDMPermission(false),
    category: 'Ticket',

    async execute(interaction, guildConfig, client) {
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'close') {
            if (!modmailUserId(interaction.channel)) {
                return replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Use this inside a modmail conversation channel.' });
            }
            if (!isModmailStaff(interaction.member, guildConfig ?? await getGuildConfig(client, interaction.guildId))) {
                return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'Only staff can close modmail conversations.' });
            }
            await InteractionHelper.safeReply(interaction, { content: 'Closing this conversation…' });
            await closeModmail(interaction.channel, interaction.user, interaction.options.getString('reason') || '');
            return;
        }

        const user = interaction.options.getUser('user', true);
        const blocked = subcommand === 'block';
        await setModmailBlocked(client, interaction.guildId, user.id, blocked);
        const open = blocked ? findModmailChannel(interaction.guild, user.id) : null;
        await InteractionHelper.safeReply(interaction, {
            content: blocked
                ? `${user} can no longer use modmail.${open ? ` Their open conversation ${open} stays until you close it.` : ''}`
                : `${user} can use modmail again.`,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        });
    },
};
