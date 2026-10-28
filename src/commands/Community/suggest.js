import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { successEmbed } from '../../utils/embeds.js';
import { userError } from '../../services/community/db.js';
import {
    createSuggestion, decideSuggestion,
    SUGGESTION_MAX_LENGTH, SUGGESTION_REASON_MAX, SUGGESTION_STATUSES,
} from '../../services/community/suggestionService.js';

export default {
    // new: everyone (commandAccess.js). status: admin-only.
    scope: 'main',
    slashOnly: true,
    category: 'Community',
    data: new SlashCommandBuilder()
        .setName('suggest')
        .setDescription('Suggest something for the server, or (admins) answer a suggestion')
        .addSubcommand((sub) => sub.setName('new').setDescription('Post a suggestion members can vote on')
            .addStringOption((option) => option.setName('text').setDescription('Your suggestion').setRequired(true).setMaxLength(SUGGESTION_MAX_LENGTH)))
        .addSubcommand((sub) => sub.setName('status').setDescription('Approve, deny or mark a suggestion as under consideration')
            .addIntegerOption((option) => option.setName('id').setDescription('Suggestion number (#)').setRequired(true).setMinValue(1))
            .addStringOption((option) => option.setName('status').setDescription('New status').setRequired(true)
                .addChoices(...SUGGESTION_STATUSES.map((status) => ({ name: status, value: status }))))
            .addStringOption((option) => option.setName('reason').setDescription('Shown on the suggestion and sent to the author').setMaxLength(SUGGESTION_REASON_MAX)))
        .setDMPermission(false),

    async execute(interaction, guildConfig, client) {
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;
        const sub = interaction.options.getSubcommand();

        if (sub === 'new') {
            const { row, message } = await createSuggestion({
                guild: interaction.guild,
                user: interaction.user,
                content: interaction.options.getString('text', true),
            });
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [successEmbed(`Suggestion #${row.id} posted`, `Members can vote on it here: ${message.url}`)],
            });
        }

        if (sub === 'status') {
            const id = interaction.options.getInteger('id', true);
            const decided = await decideSuggestion({
                client,
                guild: interaction.guild,
                suggestionId: id,
                status: interaction.options.getString('status', true),
                reason: interaction.options.getString('reason'),
                decidedBy: interaction.user.id,
            });
            if (!decided) throw userError(`There is no suggestion #${id} in this server.`);
            const { row, edited, dmed } = decided;
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [successEmbed(`Suggestion #${id}: ${row.status}`, [
                    edited ? 'The suggestion message was updated.' : 'The suggestion message could not be updated (deleted or no access).',
                    dmed ? 'The author was told by DM.' : 'The author could not be DMed.',
                ].join('\n'))],
            });
        }
    },
};
