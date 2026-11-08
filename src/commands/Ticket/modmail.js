import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { getGuildConfig } from '../../services/config/guildConfig.js';
import {
    closeModmail, findModmailChannel, isModmailStaff, modmailUserId, setModmailBlocked,
} from '../../services/modmailService.js';
import { textForGuild, textForInteraction } from '../../utils/botText.js';
import { descriptionLocalizations as localizations } from '../../utils/commandLocalizations.js';

// /modmail close is for staff (checked here); block/unblock are admin-only (commandAccess.js).
export default {
    data: new SlashCommandBuilder()
        .setName('modmail')
        .setDescription('Manage modmail conversations (members DM the bot to reach staff)')
        .setDescriptionLocalizations(localizations('ticket.cmd.modmail.description'))
        .addSubcommand((sub) => sub.setName('close').setDescription('Close this modmail conversation')
            .setDescriptionLocalizations(localizations('ticket.cmd.modmail.close.description'))
            .addStringOption((option) => option.setName('reason').setDescription('Sent to the member')
                .setDescriptionLocalizations(localizations('ticket.cmd.modmail.close.reason')).setMaxLength(500)))
        .addSubcommand((sub) => sub.setName('block').setDescription('Stop a member from using modmail')
            .setDescriptionLocalizations(localizations('ticket.cmd.modmail.block.description'))
            .addUserOption((option) => option.setName('user').setDescription('Member to block')
                .setDescriptionLocalizations(localizations('ticket.cmd.modmail.block.user')).setRequired(true)))
        .addSubcommand((sub) => sub.setName('unblock').setDescription('Let a blocked member use modmail again')
            .setDescriptionLocalizations(localizations('ticket.cmd.modmail.unblock.description'))
            .addUserOption((option) => option.setName('user').setDescription('Member to unblock')
                .setDescriptionLocalizations(localizations('ticket.cmd.modmail.unblock.user')).setRequired(true)))
        .setDMPermission(false),
    category: 'Ticket',

    async execute(interaction, guildConfig, client) {
        const tr = textForInteraction(interaction);
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'close') {
            if (!(await modmailUserId(interaction.channel))) {
                return replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: tr.t('ticket.modmail.notModmail') });
            }
            if (!isModmailStaff(interaction.member, guildConfig ?? await getGuildConfig(client, interaction.guildId))) {
                return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('ticket.modmail.staffOnly') });
            }
            // Not ephemeral: posted in the conversation channel, so the server's language.
            const pub = textForGuild(interaction.guildId, { member: interaction.member, purpose: 'public' });
            await InteractionHelper.safeReply(interaction, { content: pub.t('ticket.modmail.closing') });
            await closeModmail(interaction.channel, interaction.user, interaction.options.getString('reason') || '');
            return;
        }

        const user = interaction.options.getUser('user', true);
        const blocked = subcommand === 'block';
        // The answer is ephemeral: acknowledge before the write and the channel lookup.
        await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        await setModmailBlocked(client, interaction.guildId, user.id, blocked);
        const open = blocked ? await findModmailChannel(interaction.guild, user.id) : null;
        await InteractionHelper.safeReply(interaction, {
            content: blocked
                ? `${tr.t('ticket.modmail.blocked', { user: String(user) })}${open ? tr.t('ticket.modmail.openStays', { channel: String(open) }) : ''}`
                : tr.t('ticket.modmail.unblocked', { user: String(user) }),
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        });
    },
};
