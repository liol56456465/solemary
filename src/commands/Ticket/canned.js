import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed } from '../../utils/embeds.js';
import { getGuildConfig } from '../../services/config/guildConfig.js';
import { isModmailStaff, modmailUserId, sendStaffTextToMember } from '../../services/modmailService.js';
import {
    CANNED_MAX_LENGTH, CANNED_NAME, getCanned, isBuiltInCanned, listCanned, removeCanned, saveCanned,
} from '../../services/cannedService.js';

// send/list: staff (checked here; open at the gate). add/remove: admin-only (commandAccess.js).
export default {
    scope: 'main',
    data: new SlashCommandBuilder()
        .setName('canned')
        .setDescription('Saved answers for staff in tickets, appeals and modmail')
        .addSubcommand((sub) => sub.setName('send').setDescription('Post a saved answer in this channel')
            .addStringOption((option) => option.setName('name').setDescription('Which answer').setRequired(true).setAutocomplete(true)))
        .addSubcommand((sub) => sub.setName('list').setDescription('Show all saved answers'))
        .addSubcommand((sub) => sub.setName('add').setDescription('Save a new answer (or replace one)')
            .addStringOption((option) => option.setName('name').setDescription('Short name: lowercase letters, digits and -').setRequired(true).setMaxLength(32))
            .addStringOption((option) => option.setName('text').setDescription('The answer').setRequired(true).setMaxLength(CANNED_MAX_LENGTH)))
        .addSubcommand((sub) => sub.setName('remove').setDescription('Delete a saved answer')
            .addStringOption((option) => option.setName('name').setDescription('Which answer').setRequired(true).setAutocomplete(true)))
        .setDMPermission(false),
    category: 'Ticket',

    async autocomplete(interaction) {
        const typed = String(interaction.options.getFocused() ?? '').toLowerCase();
        const names = Object.keys(await listCanned(interaction.guildId).catch(() => ({})));
        await interaction.respond(names.filter((name) => name.includes(typed)).slice(0, 25).map((name) => ({ name, value: name })));
    },

    async execute(interaction, guildConfig, client) {
        const sub = interaction.options.getSubcommand();
        const config = guildConfig ?? await getGuildConfig(client, interaction.guildId);
        if ((sub === 'send' || sub === 'list') && !isModmailStaff(interaction.member, config)) {
            return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'Saved answers are for staff (ticket staff role, Manage Channels or Administrator).' });
        }
        const name = interaction.options.getString('name')?.trim().toLowerCase();

        if (sub === 'send') {
            const text = await getCanned(interaction.guildId, name);
            if (!text) return replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: `There is no saved answer called **${name}**.` });
            const staffName = interaction.member?.displayName || interaction.user.username;
            await interaction.channel.send({ content: `**${staffName} (staff):**\n${text}`, allowedMentions: { parse: [] } });
            // In a modmail channel the member only sees what reaches their DMs.
            if (await modmailUserId(interaction.channel)) await sendStaffTextToMember(interaction.channel, staffName, text);
            return InteractionHelper.safeReply(interaction, { content: `Sent **${name}**.`, flags: MessageFlags.Ephemeral });
        }

        if (sub === 'list') {
            const all = await listCanned(interaction.guildId);
            const lines = Object.entries(all).map(([key, text]) =>
                `**${key}**${isBuiltInCanned(key) ? ' (built-in)' : ''}\n${text.length > 150 ? `${text.slice(0, 149)}…` : text}`);
            return InteractionHelper.safeReply(interaction, {
                embeds: [createEmbed({ title: 'Saved answers', description: lines.join('\n\n').slice(0, 4000), color: 'primary' })],
                flags: MessageFlags.Ephemeral,
            });
        }

        if (!CANNED_NAME.test(name ?? '')) {
            return replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Names use lowercase letters, digits and - (up to 32).' });
        }
        if (sub === 'add') {
            await saveCanned(interaction.guildId, name, interaction.options.getString('text').trim());
            return InteractionHelper.safeReply(interaction, { content: `Saved **${name}**. Staff can post it with \`/canned send\`.`, flags: MessageFlags.Ephemeral });
        }
        if (sub === 'remove') {
            const removed = await removeCanned(interaction.guildId, name);
            const message = removed ? `Deleted **${name}**.`
                : isBuiltInCanned(name) ? `**${name}** is built in and can't be deleted (you can replace its text with \`/canned add\`).`
                    : `There is no saved answer called **${name}**.`;
            return InteractionHelper.safeReply(interaction, { content: message, flags: MessageFlags.Ephemeral });
        }
    },
};
