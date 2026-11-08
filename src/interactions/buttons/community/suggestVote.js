import { MessageFlags } from 'discord.js';
import { buildSuggestionMessage, castVote, VOTE_BUTTON_ID } from '../../../services/community/suggestionService.js';
import { textForInteraction } from '../../../utils/botText.js';

// suggest_vote:<id>:up|down — one vote per member, changeable; same button again withdraws it.
// The ephemeral notes are in the voter's language; the suggestion post stays in the server's.
export default {
    name: VOTE_BUTTON_ID,
    async execute(interaction, client, args) {
        const tr = textForInteraction(interaction);
        const suggestionId = Number.parseInt(args[0], 10);
        const clicked = args[1] === 'up' ? 1 : args[1] === 'down' ? -1 : 0;
        if (!interaction.guildId || !Number.isInteger(suggestionId) || clicked === 0) {
            return interaction.reply({ content: tr.t('community.suggest.vote.invalid'), flags: MessageFlags.Ephemeral });
        }
        // Acknowledge before the vote transaction; update() below then edits the post and the
        // "gone" note is an ephemeral follow-up.
        await interaction.deferUpdate();
        const result = await castVote({ suggestionId, guildId: interaction.guildId, userId: interaction.user.id, clicked, lang: tr.lang });
        if (!result) {
            return interaction.followUp({ content: tr.t('community.suggest.vote.gone'), flags: MessageFlags.Ephemeral });
        }
        const author = await client.users.fetch(result.row.user_id).catch(() => null);
        const postLang = textForInteraction(interaction, { purpose: 'public' }).lang;
        await interaction.editReply(buildSuggestionMessage(result.row, author, { lang: postLang }));
        const note = result.vote === 1 ? tr.t('community.suggest.vote.up') : result.vote === -1 ? tr.t('community.suggest.vote.down') : tr.t('community.suggest.vote.removed');
        await interaction.followUp({ content: tr.t('community.suggest.vote.hint', { note }), flags: MessageFlags.Ephemeral }).catch(() => {});
    },
};
