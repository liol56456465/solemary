import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { textForInteraction } from '../../utils/botText.js';
import { descriptionLocalizations } from '../../utils/commandLocalizations.js';
import { getGuildConfig } from '../../services/config/guildConfig.js';
import {
    closeModmail, findModmailChannel, isModmailStaff, modmailUserId, setModmailBlocked,
} from '../../services/modmailService.js';

// /modmail close is for staff (checked here); block/unblock are admin-only (commandAccess.js).
// Ephemeral answers: the staff member's Discord language; "Closing…" is posted in the
// conversation channel: the server's language.
export default {
    data: new SlashCommandBuilder()
        .setName('modmail')
        .setDescription('Manage modmail conversations (members DM the bot to reach staff)')
        .setDescriptionLocalizations(descriptionLocalizations('staff.modmail.cmd.description'))
        .addSubcommand((sub) => sub.setName('close').setDescription('Close this modmail conversation')
            .setDescriptionLocalizations(descriptionLocalizations('staff.modmail.cmd.close'))
            .addStringOption((option) => option.setName('reason').setDescription('Sent to the member')
                .setDescriptionLocalizations(descriptionLocalizations('staff.modmail.cmd.reason')).setMaxLength(500)))
        .addSubcommand((sub) => sub.setName('block').setDescription('Stop a member from using modmail')
            .setDescriptionLocalizations(descriptionLocalizations('staff.modmail.cmd.block'))
            .addUserOption((option) => option.setName('user').setDescription('Member to block')
                .setDescriptionLocalizations(descriptionLocalizations('staff.modmail.cmd.blockUser')).setRequired(true)))
        .addSubcommand((sub) => sub.setName('unblock').setDescription('Let a blocked member use modmail again')
            .setDescriptionLocalizations(descriptionLocalizations('staff.modmail.cmd.unblock'))
            .addUserOption((option) => option.setName('user').setDescription('Member to unblock')
                .setDescriptionLocalizations(descriptionLocalizations('staff.modmail.cmd.unblockUser')).setRequired(true)))
        .setDMPermission(false),
    category: 'Ticket',

    async execute(interaction, guildConfig, client) {
        const subcommand = interaction.options.getSubcommand();
        const tr = textForInteraction(interaction);

        if (subcommand === 'close') {
            if (!(await modmailUserId(interaction.channel))) {
                return replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: tr.t('staff.modmail.notConversationChannel') });
            }
            if (!isModmailStaff(interaction.member, guildConfig ?? await getGuildConfig(client, interaction.guildId))) {
                return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('staff.modmail.staffOnly') });
            }
            const channelTr = textForInteraction(interaction, { purpose: 'public' });
            await InteractionHelper.safeReply(interaction, { content: channelTr.t('staff.modmail.closing') });
            await closeModmail(interaction.channel, interaction.user, interaction.options.getString('reason') || '');
            return;
        }

        const user = interaction.options.getUser('user', true);
        const blocked = subcommand === 'block';
        await setModmailBlocked(client, interaction.guildId, user.id, blocked);
        const open = blocked ? await findModmailChannel(interaction.guild, user.id) : null;
        await InteractionHelper.safeReply(interaction, {
            content: blocked
                ? `${tr.t('staff.modmail.blocked', { user: String(user) })}${open ? tr.t('staff.modmail.blockedOpen', { channel: String(open) }) : ''}`
                : tr.t('staff.modmail.unblocked', { user: String(user) }),
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        });
    },
};
