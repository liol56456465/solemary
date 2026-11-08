import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed } from '../../utils/embeds.js';
import { getGuildConfig } from '../../services/config/guildConfig.js';
import { isModmailStaff, modmailUserId, sendStaffTextToMember } from '../../services/modmailService.js';
import {
    CANNED_MAX_LENGTH, CANNED_NAME, getCanned, isBuiltInCanned, listCanned, removeCanned, saveCanned,
} from '../../services/cannedService.js';
import { textForGuild, textForInteraction } from '../../utils/botText.js';
import { descriptionLocalizations as localizations } from '../../utils/commandLocalizations.js';

// send/list: staff (checked here; open at the gate). add/remove: admin-only (commandAccess.js).
export default {
    data: new SlashCommandBuilder()
        .setName('canned')
        .setDescription('Saved answers for staff in tickets, appeals and modmail')
        .setDescriptionLocalizations(localizations('ticket.cmd.canned.description'))
        .addSubcommand((sub) => sub.setName('send').setDescription('Post a saved answer in this channel')
            .setDescriptionLocalizations(localizations('ticket.cmd.canned.send.description'))
            .addStringOption((option) => option.setName('name').setDescription('Which answer')
                .setDescriptionLocalizations(localizations('ticket.cmd.canned.send.name')).setRequired(true).setAutocomplete(true)))
        .addSubcommand((sub) => sub.setName('list').setDescription('Show all saved answers')
            .setDescriptionLocalizations(localizations('ticket.cmd.canned.list.description')))
        .addSubcommand((sub) => sub.setName('add').setDescription('Save a new answer (or replace one)')
            .setDescriptionLocalizations(localizations('ticket.cmd.canned.add.description'))
            .addStringOption((option) => option.setName('name').setDescription('Short name: lowercase letters, digits and -')
                .setDescriptionLocalizations(localizations('ticket.cmd.canned.add.name')).setRequired(true).setMaxLength(32))
            .addStringOption((option) => option.setName('text').setDescription('The answer')
                .setDescriptionLocalizations(localizations('ticket.cmd.canned.add.text')).setRequired(true).setMaxLength(CANNED_MAX_LENGTH)))
        .addSubcommand((sub) => sub.setName('remove').setDescription('Delete a saved answer')
            .setDescriptionLocalizations(localizations('ticket.cmd.canned.remove.description'))
            .addStringOption((option) => option.setName('name').setDescription('Which answer')
                .setDescriptionLocalizations(localizations('ticket.cmd.canned.remove.name')).setRequired(true).setAutocomplete(true)))
        .setDMPermission(false),
    category: 'Ticket',

    async autocomplete(interaction) {
        const typed = String(interaction.options.getFocused() ?? '').toLowerCase();
        const names = Object.keys(await listCanned(interaction.guildId).catch(() => ({})));
        await interaction.respond(names.filter((name) => name.includes(typed)).slice(0, 25).map((name) => ({ name, value: name })));
    },

    async execute(interaction, guildConfig, client) {
        const tr = textForInteraction(interaction);
        const sub = interaction.options.getSubcommand();
        // Every answer is ephemeral (the canned text itself is a channel message): acknowledge
        // before the config read, the database and the DM to the member.
        await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        const config = guildConfig ?? await getGuildConfig(client, interaction.guildId);
        if ((sub === 'send' || sub === 'list') && !isModmailStaff(interaction.member, config)) {
            return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: tr.t('ticket.canned.staffOnly') });
        }
        const name = interaction.options.getString('name')?.trim().toLowerCase();

        if (sub === 'send') {
            // Posted in the channel: the server's language (also for the built-in answers).
            const pub = textForGuild(interaction.guildId, { member: interaction.member, purpose: 'public' });
            const text = await getCanned(interaction.guildId, name, { lang: pub.lang });
            if (!text) return replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: tr.t('ticket.canned.missing', { name }) });
            const staffName = interaction.member?.displayName || interaction.user.username;
            await interaction.channel.send({ content: pub.t('ticket.canned.staffLine', { staff: staffName, text }), allowedMentions: { parse: [] } });
            // In a modmail channel the member only sees what reaches their DMs.
            if (await modmailUserId(interaction.channel)) await sendStaffTextToMember(interaction.channel, staffName, text);
            return InteractionHelper.safeReply(interaction, { content: tr.t('ticket.canned.sent', { name }), flags: MessageFlags.Ephemeral });
        }

        if (sub === 'list') {
            const all = await listCanned(interaction.guildId, { lang: tr.lang });
            const lines = Object.entries(all).map(([key, text]) =>
                `**${key}**${isBuiltInCanned(key) ? tr.t('ticket.canned.builtInTag') : ''}\n${text.length > 150 ? `${text.slice(0, 149)}…` : text}`);
            return InteractionHelper.safeReply(interaction, {
                embeds: [createEmbed({ title: tr.t('ticket.canned.listTitle'), description: lines.join('\n\n').slice(0, 4000), color: 'primary' })],
                flags: MessageFlags.Ephemeral,
            });
        }

        if (!CANNED_NAME.test(name ?? '')) {
            return replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: tr.t('ticket.canned.badName') });
        }
        if (sub === 'add') {
            await saveCanned(interaction.guildId, name, interaction.options.getString('text').trim());
            return InteractionHelper.safeReply(interaction, { content: tr.t('ticket.canned.saved', { name }), flags: MessageFlags.Ephemeral });
        }
        if (sub === 'remove') {
            const removed = await removeCanned(interaction.guildId, name);
            const message = removed ? tr.t('ticket.canned.deleted', { name })
                : isBuiltInCanned(name) ? tr.t('ticket.canned.builtInNoDelete', { name })
                    : tr.t('ticket.canned.missing', { name });
            return InteractionHelper.safeReply(interaction, { content: message, flags: MessageFlags.Ephemeral });
        }
    },
};
