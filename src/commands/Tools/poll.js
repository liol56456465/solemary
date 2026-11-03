import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import {
    NATIVE_POLL_DEFAULT_HOURS, NATIVE_POLL_MAX_HOURS, NATIVE_POLL_MIN_HOURS, NATIVE_POLL_QUESTION_MAX, POLL_MAX_OPTIONS as MAX_OPTIONS, POLL_OPTION_MAX,
    createNativePoll, createPoll, endPoll,
} from '../../services/botMessageService.js';

const ORDINALS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'];

// /poll create posts a native Discord poll (or, with anonymous, the old reaction poll);
// /poll end ends one of Mewvo's native polls right away. Both are Administrator-only
// (unlisted keys default to Administrator in commandAccess.js). Subcommands keep the
// server's command count unchanged.
export default {
    data: new SlashCommandBuilder()
        .setName('poll')
        .setDescription('Post a poll, or end one early')
        .addSubcommand((sub) => {
            sub.setName('create')
                .setDescription('Post a Discord poll with 2 to 10 options')
                .addStringOption((option) => option.setName('question')
                    .setDescription('The poll question')
                    .setMaxLength(NATIVE_POLL_QUESTION_MAX)
                    .setRequired(true));
            for (let i = 1; i <= MAX_OPTIONS; i++) {
                sub.addStringOption((option) => option.setName(`option${i}`)
                    .setDescription(`${ORDINALS[i - 1]} option${i <= 2 ? '' : ' (optional)'}: up to 55 characters, 100 if anonymous`)
                    .setMaxLength(POLL_OPTION_MAX)
                    .setRequired(i <= 2));
            }
            return sub
                .addIntegerOption((option) => option.setName('hours')
                    .setDescription(`How long the poll stays open, in hours: ${NATIVE_POLL_MIN_HOURS} to ${NATIVE_POLL_MAX_HOURS} (7 days). Default ${NATIVE_POLL_DEFAULT_HOURS}.`)
                    .setMinValue(NATIVE_POLL_MIN_HOURS)
                    .setMaxValue(NATIVE_POLL_MAX_HOURS)
                    .setRequired(false))
                .addBooleanOption((option) => option.setName('multiple')
                    .setDescription('Let members pick more than one option (default: no)')
                    .setRequired(false))
                .addBooleanOption((option) => option.setName('anonymous')
                    .setDescription('Use a number-reaction poll instead, since Discord polls list who voted. No time limit.')
                    .setRequired(false));
        })
        .addSubcommand((sub) => sub.setName('end')
            .setDescription('End one of Mewvo\'s Discord polls now and show the final results')
            .addStringOption((option) => option.setName('message_link')
                .setDescription('The poll\'s message link (right-click the poll, then Copy Message Link)')
                .setMaxLength(200)
                .setRequired(true))),

    async execute(interaction) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferSuccess) {
            logger.warn(`Poll interaction defer failed`, {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'poll'
            });
            return;
        }

        if (interaction.options.getSubcommand() === 'end') {
            const { message } = await endPoll(interaction.guild, interaction.options.getString('message_link'));
            await InteractionHelper.safeEditReply(interaction, {
                content: `Poll ended. The final results are now shown on it: ${message.url}`,
            });
            return;
        }

        const question = interaction.options.getString('question');
        const options = [];
        for (let i = 1; i <= MAX_OPTIONS; i++) {
            const option = interaction.options.getString(`option${i}`);
            if (option) options.push(option);
        }
        const hours = interaction.options.getInteger('hours');
        const multiple = interaction.options.getBoolean('multiple');

        // Same polls as the dashboard's Messages page (checks the bot's permissions first).
        if (interaction.options.getBoolean('anonymous')) {
            await createPoll(interaction.guild, { channel: interaction.channel, question, options, anonymous: true });
            const ignored = hours !== null || multiple !== null
                ? ' Hours and multiple only apply to Discord polls, so they were ignored.'
                : '';
            await InteractionHelper.safeEditReply(interaction, { content: `Reaction poll posted.${ignored}` });
            return;
        }

        const { message, endsAt } = await createNativePoll(interaction.guild, {
            channel: interaction.channel, question, options, durationHours: hours ?? NATIVE_POLL_DEFAULT_HOURS, multiSelect: Boolean(multiple),
        });
        const unix = Math.floor(endsAt / 1000);
        await InteractionHelper.safeEditReply(interaction, {
            content: `Poll posted. It closes <t:${unix}:F> (<t:${unix}:R>). To close it early, use /poll end with this link: ${message.url}`,
        });
    },
};
