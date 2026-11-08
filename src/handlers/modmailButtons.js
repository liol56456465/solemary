import { MessageFlags } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import {
    MODMAIL_BUTTONS, MODMAIL_PICK, closeModmail, isModmailStaff, modmailUserId, openModmail,
} from '../services/modmailService.js';

const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Opens the conversation for the DM prompt's message in the chosen server and replaces the
 * prompt with the status. A prompt from before multi-server has no server id: the main server.
 * `open` is for tests.
 */
export async function openFromPrompt(interaction, client, messageId, guildId, { open = openModmail } = {}) {
    await interaction.deferUpdate();
    let status;
    try {
        const dmChannel = interaction.channel ?? await interaction.user.createDM();
        if (!SNOWFLAKE.test(messageId ?? '') || (guildId !== undefined && !SNOWFLAKE.test(guildId ?? ''))) {
            status = 'That prompt is broken. Send your message again.';
        } else {
            status = guildId === undefined
                ? await open(client, interaction.user, dmChannel, messageId)
                : await open(client, interaction.user, dmChannel, messageId, guildId);
        }
    } catch (error) {
        logger.error(`Opening modmail for ${interaction.user.id} failed:`, error);
        status = 'Could not reach the staff right now. Please try again later.';
    }
    await interaction.editReply({ content: status, components: [] }).catch(() => {});
}

// "Send to staff" under the DM prompt: `modmail_open:<messageId>[:<guildId>]`.
// openModmail re-checks that the message belongs to the clicking user and every server rule.
export const openModmailHandler = {
    name: MODMAIL_BUTTONS.open,
    async execute(interaction, client, args) {
        const [messageId, guildId] = args;
        return openFromPrompt(interaction, client, messageId, guildId);
    },
};

// "Which server?" under the DM prompt: `modmail_pick:<messageId>`, the value is the server id.
export const pickModmailServerHandler = {
    name: MODMAIL_PICK,
    async execute(interaction, client, args) {
        const [messageId] = args;
        const [guildId = ''] = interaction.values || [];
        return openFromPrompt(interaction, client, messageId, guildId);
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
        if (!interaction.guildId || !(await modmailUserId(interaction.channel))) {
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
