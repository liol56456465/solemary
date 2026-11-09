import { MessageFlags } from 'discord.js';
import { logger } from '../utils/logger.js';
import { botText, textForInteraction } from '../utils/botText.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import {
    MODMAIL_BUTTONS, MODMAIL_PICK, closeModmail, isModmailStaff, memberModmailLang, modmailUserId, openModmail,
} from '../services/modmailService.js';

const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Opens the conversation for the DM prompt's message in the chosen server and replaces the
 * prompt with the status. A prompt from before multi-server has no server id: the main server.
 * `open` is for tests.
 */
export async function openFromPrompt(interaction, client, messageId, guildId, { open = openModmail } = {}) {
    await interaction.deferUpdate();
    // Like the prompt it replaces: the member's language for that server (none: personal, else English).
    const mt = botText(memberModmailLang(interaction.user.id, SNOWFLAKE.test(guildId ?? '') ? client?.guilds?.cache?.get?.(guildId) ?? null : null));
    let status;
    try {
        const dmChannel = interaction.channel ?? await interaction.user.createDM();
        if (!SNOWFLAKE.test(messageId ?? '') || (guildId !== undefined && !SNOWFLAKE.test(guildId ?? ''))) {
            status = mt.t('member.modmail.broken');
        } else {
            status = guildId === undefined
                ? await open(client, interaction.user, dmChannel, messageId)
                : await open(client, interaction.user, dmChannel, messageId, guildId);
        }
    } catch (error) {
        logger.error(`Opening modmail for ${interaction.user.id} failed:`, error);
        status = mt.t('member.modmail.failed');
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
        // No server in this button: the member's personal language, else their Discord language.
        await interaction.update({ content: textForInteraction(interaction).t('member.modmail.notSent'), components: [] }).catch(() => {});
    },
};

// Close button on the staff channel header.
export const closeModmailHandler = {
    name: MODMAIL_BUTTONS.close,
    async execute(interaction, client) {
        // Refusals are ephemeral (the clicker's language); "Closing…" is posted in the channel (the server's).
        const tr = textForInteraction(interaction);
        // Acknowledge before the link lookup and the config read; the answers are follow-ups
        // (ephemeral refusals, the public "Closing…").
        await interaction.deferUpdate();
        if (!interaction.guildId || !(await modmailUserId(interaction.channel))) {
            await interaction.followUp({ content: tr.t('staff.modmail.notOpen'), flags: MessageFlags.Ephemeral });
            return;
        }
        const config = await getGuildConfig(client, interaction.guild.id);
        if (!isModmailStaff(interaction.member, config)) {
            await interaction.followUp({ content: tr.t('staff.modmail.staffOnly'), flags: MessageFlags.Ephemeral });
            return;
        }
        await interaction.followUp({ content: textForInteraction(interaction, { purpose: 'public' }).t('staff.modmail.closing'), allowedMentions: { parse: [] } });
        await closeModmail(interaction.channel, interaction.user);
    },
};
