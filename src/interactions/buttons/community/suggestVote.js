import { MessageFlags } from 'discord.js';
import { buildSuggestionMessage, castVote, VOTE_BUTTON_ID } from '../../../services/community/suggestionService.js';

// suggest_vote:<id>:up|down — one vote per member, changeable; same button again withdraws it.
export default {
    name: VOTE_BUTTON_ID,
    async execute(interaction, client, args) {
        const suggestionId = Number.parseInt(args[0], 10);
        const clicked = args[1] === 'up' ? 1 : args[1] === 'down' ? -1 : 0;
        if (!interaction.guildId || !Number.isInteger(suggestionId) || clicked === 0) {
            return interaction.reply({ content: 'This button is not valid.', flags: MessageFlags.Ephemeral });
        }
        const result = await castVote({ suggestionId, guildId: interaction.guildId, userId: interaction.user.id, clicked });
        if (!result) {
            return interaction.reply({ content: 'This suggestion no longer exists.', flags: MessageFlags.Ephemeral });
        }
        const author = await client.users.fetch(result.row.user_id).catch(() => null);
        await interaction.update(buildSuggestionMessage(result.row, author));
        const note = result.vote === 1 ? 'You voted 👍.' : result.vote === -1 ? 'You voted 👎.' : 'Your vote was removed.';
        await interaction.followUp({ content: `${note} Click the other button to change it, or the same one to withdraw it.`, flags: MessageFlags.Ephemeral }).catch(() => {});
    },
};
