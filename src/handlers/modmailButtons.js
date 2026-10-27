import { MessageFlags } from 'discord.js';
import { logger } from '../utils/logger.js';
import { enforcementConfig } from '../config/enforcement.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import {
    MODMAIL_BUTTONS, closeModmail, isModmailStaff, modmailUserId, openModmail,
} from '../services/modmailService.js';

// "Send to staff" under the DM prompt. The customId carries the DM's message id;
// openModmail re-checks that the message belongs to the clicking user.
export const openModmailHandler = {
    name: MODMAIL_BUTTONS.open,
    async execute(interaction, client, args) {
        await interaction.deferUpdate();
        const [messageId] = args;
        let status;
        try {
            const dmChannel = interaction.channel ?? await interaction.user.createDM();
            status = /^\d{17,20}$/.test(messageId ?? '')
                ? await openModmail(client, interaction.user, dmChannel, messageId)
                : 'That prompt is broken. Send your message again.';
        } catch (error) {
            logger.error(`Opening modmail for ${interaction.user.id} failed:`, error);
            status = 'Could not reach the staff right now. Please try again later.';
        }
        await interaction.editReply({ content: status, components: [] }).catch(() => {});
    },
};

export const cancelModmailHandler = {
    name: MODMAIL_BUTTONS.cancel,
    async execute(interaction) {
        await interaction.update({ content: 'Not sent.', components: [] }).catch(() => {});
    },
};

// Close button on the staff channel header.
export const closeModmailHandler = {
    name: MODMAIL_BUTTONS.close,
    async execute(interaction, client) {
        if (interaction.guildId !== enforcementConfig.mainGuildId || !modmailUserId(interaction.channel)) {
            await interaction.reply({ content: 'This is not an open modmail conversation.', flags: MessageFlags.Ephemeral });
            return;
        }
        const config = await getGuildConfig(client, interaction.guild.id);
        if (!isModmailStaff(interaction.member, config)) {
            await interaction.reply({ content: 'Only staff can close modmail conversations.', flags: MessageFlags.Ephemeral });
            return;
        }
        await interaction.reply({ content: 'Closing this conversation…' });
        await closeModmail(interaction.channel, interaction.user);
    },
};
