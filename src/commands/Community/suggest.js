import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { successEmbed } from '../../utils/embeds.js';
import { userError } from '../../services/community/db.js';
import {
    createSuggestion, decideSuggestion,
    SUGGESTION_MAX_LENGTH, SUGGESTION_REASON_MAX, SUGGESTION_STATUSES,
} from '../../services/community/suggestionService.js';
import { textForInteraction } from '../../utils/botText.js';
import { describe, descriptionLocalizations, englishDescription } from '../../utils/commandLocalizations.js';

const STATUS_WORD_KEYS = {
    approved: 'community.suggest.statusWord.approved',
    denied: 'community.suggest.statusWord.denied',
    considering: 'community.suggest.statusWord.considering',
};

export default {
    // new: everyone (commandAccess.js). status: admin-only.
    slashOnly: true,
    category: 'Community',
    data: describe(new SlashCommandBuilder()
        .setName('suggest'), 'community.cmd.suggest.desc')
        .addSubcommand((sub) => describe(sub.setName('new'), 'community.cmd.suggest.new')
            .addStringOption((option) => describe(option.setName('text'), 'community.cmd.suggest.text').setRequired(true).setMaxLength(SUGGESTION_MAX_LENGTH)))
        .addSubcommand((sub) => describe(sub.setName('status'), 'community.cmd.suggest.status')
            .addIntegerOption((option) => describe(option.setName('id'), 'community.cmd.suggest.id').setRequired(true).setMinValue(1))
            .addStringOption((option) => describe(option.setName('status'), 'community.cmd.suggest.statusOption').setRequired(true)
                .addChoices(...SUGGESTION_STATUSES.map((status) => ({
                    name: englishDescription(STATUS_WORD_KEYS[status]), name_localizations: descriptionLocalizations(STATUS_WORD_KEYS[status]), value: status,
                }))))
            .addStringOption((option) => describe(option.setName('reason'), 'community.cmd.suggest.reason').setMaxLength(SUGGESTION_REASON_MAX)))
        .setDMPermission(false),

    async execute(interaction, guildConfig, client) {
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;
        const sub = interaction.options.getSubcommand();
        const tr = textForInteraction(interaction);

        if (sub === 'new') {
            const { row, message } = await createSuggestion({
                guild: interaction.guild,
                user: interaction.user,
                content: interaction.options.getString('text', true),
                lang: tr.lang,
            });
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [successEmbed(tr.t('community.suggest.postedTitle', { id: row.id }), tr.t('community.suggest.postedText', { url: message.url }))],
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
                lang: tr.lang,
            });
            if (!decided) throw userError(tr.t('community.suggest.notFound', { id }));
            const { row, edited, dmed } = decided;
            const status = STATUS_WORD_KEYS[row.status] ? tr.t(STATUS_WORD_KEYS[row.status]) : row.status;
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [successEmbed(tr.t('community.suggest.decidedTitle', { id, status }), [
                    edited ? tr.t('community.suggest.edited') : tr.t('community.suggest.notEdited'),
                    dmed ? tr.t('community.suggest.dmed') : tr.t('community.suggest.notDmed'),
                ].join('\n'))],
            });
        }
    },
};
