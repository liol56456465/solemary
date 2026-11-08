// /remind: personal reminders (services/reminders/reminderService.js).
//   /remind me in:2h text:…   set one (1 minute to 1 year, up to 25 at a time)
//   /remind list              your reminders that haven't gone off yet
//   /remind delete id:        remove one of them
// Everyone may use it; every reply is private. The reminder comes as a DM, or in this
// channel if your DMs are closed.

import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { botText } from '../../utils/botText.js';
import { localized, replyText } from '../Core/modules/commandText.js';
import { ReminderError, reminderDelay, reminderStore } from '../../services/reminders/reminderService.js';

const ts = (date, style) => `<t:${Math.floor(new Date(date).getTime() / 1000)}:${style}>`;

/** The /remind list text. Pure, for tests; `tr` (botText) picks the language, English by default. */
export function listText(rows, tr = botText('en')) {
    if (!rows.length) return tr.t('utility.remind.none');
    return rows.map((r) => `\`${r.id}\` ${ts(r.due_at, 'R')}: ${r.text.length > 80 ? `${r.text.slice(0, 79)}…` : r.text}`).join('\n');
}

export default {
    data: new SlashCommandBuilder()
        .setName('remind')
        .setDescription('Reminders for yourself')
        .setDescriptionLocalizations(localized('utility.slash.remind.description'))
        .addSubcommand((sub) => sub.setName('me').setDescription('Remind me about something later')
            .setDescriptionLocalizations(localized('utility.slash.remind.sub.me.description'))
            .addStringOption((o) => o.setName('in').setDescription('When, like 10m, 2h, 1d or 1d12h')
                .setDescriptionLocalizations(localized('utility.slash.remind.sub.me.options.in')).setRequired(true).setMaxLength(20))
            .addStringOption((o) => o.setName('text').setDescription('What to remind you about')
                .setDescriptionLocalizations(localized('utility.slash.remind.sub.me.options.text')).setRequired(true).setMaxLength(500)))
        .addSubcommand((sub) => sub.setName('list').setDescription('Your reminders that haven\'t gone off yet')
            .setDescriptionLocalizations(localized('utility.slash.remind.sub.list.description')))
        .addSubcommand((sub) => sub.setName('delete').setDescription('Delete one of your reminders')
            .setDescriptionLocalizations(localized('utility.slash.remind.sub.delete.description'))
            .addIntegerOption((o) => o.setName('id').setDescription('The number from /remind list')
                .setDescriptionLocalizations(localized('utility.slash.remind.sub.delete.options.id')).setRequired(true).setMinValue(1))),

    // (interaction, guildConfig, client) from the dispatcher; the 4th argument is for tests.
    async execute(interaction, guildConfig, client, { store = reminderStore } = {}) {
        // Every reply is private: the user's language.
        const tr = replyText(interaction);
        const reply = (description, color = 'primary', title = tr.t('utility.remind.title')) => InteractionHelper.safeReply(interaction, {
            embeds: [createEmbed({ title, description, color })], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] },
        });
        const sub = interaction.options.getSubcommand();
        const userId = interaction.user.id;
        try {
            if (sub === 'me') {
                const delayMs = reminderDelay(interaction.options.getString('in', true));
                const row = await store.create({
                    userId, guildId: interaction.guildId || null, channelId: interaction.channelId || null,
                    text: interaction.options.getString('text', true), delayMs,
                });
                return reply(tr.t('utility.remind.set', { relative: ts(row.due_at, 'R'), time: ts(row.due_at, 'f') }), 'success', tr.t('utility.remind.setTitle'));
            }
            if (sub === 'list') return reply(listText(await store.listActive(userId), tr));
            const removed = await store.remove(userId, interaction.options.getInteger('id', true));
            return removed
                ? reply(tr.t('utility.remind.deleted', { id: removed.id }), 'success', tr.t('utility.remind.deletedTitle'))
                : reply(tr.t('utility.remind.notFound'), 'warning');
        } catch (error) {
            if (error instanceof ReminderError) return reply(error.userMessage, 'warning');
            logger.error(`/remind ${sub} failed for ${userId}: ${error.message}`);
            return reply(tr.t('utility.remind.dbDown'), 'error', tr.t('utility.remind.dbDownTitle'));
        }
    },
};
