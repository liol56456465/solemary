import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { successEmbed } from '../../utils/embeds.js';
import { ErrorTypes, TitanBotError } from '../../utils/errorHandler.js';
import { enforcementConfig } from '../../config/enforcement.js';
import { isAdministrator } from '../../services/enforcement/enforcementService.js';
import { decideAppeal } from '../../services/enforcement/appealService.js';
import { normalizeCaseCode } from '../../services/enforcement/format.js';

export default {
    // Registered as a guild command in SUPPORT_GUILD_ID only.
    scope: 'support',
    data: new SlashCommandBuilder()
        .setName('appeals')
        .setDescription('Accept or deny a pending appeal')
        .addStringOption((option) => option
            .setName('code')
            .setDescription('Case code of the appeal')
            .setRequired(true)
            .setMinLength(5)
            .setMaxLength(7))
        .addStringOption((option) => option
            .setName('decision')
            .setDescription('Accept lifts the punishment; deny keeps it')
            .setRequired(true)
            .addChoices({ name: 'accept', value: 'accept' }, { name: 'deny', value: 'deny' }))
        .addStringOption((option) => option
            .setName('note')
            .setDescription('Optional note, shown in the appeal channel and the log')
            .setMaxLength(500)),

    async execute(interaction, config, client) {
        if (interaction.guildId !== enforcementConfig.supportGuildId) {
            throw new TitanBotError('Wrong guild for /appeals', ErrorTypes.PERMISSION,
                'This command only works in the support server.', { expected: true });
        }
        if (!isAdministrator(interaction.member)) {
            throw new TitanBotError('Not an administrator', ErrorTypes.PERMISSION,
                'You need the Administrator permission to decide appeals.', { expected: true });
        }

        const caseCode = normalizeCaseCode(interaction.options.getString('code'));
        if (!caseCode) {
            throw new TitanBotError('Invalid case code', ErrorTypes.USER_INPUT,
                'That is not a valid case code (5–7 letters and digits).', { expected: true });
        }

        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        const decision = interaction.options.getString('decision');
        const result = await decideAppeal({
            client,
            supportGuild: interaction.guild,
            admin: interaction.user,
            caseCode,
            decision,
            note: interaction.options.getString('note')?.trim() || null,
        });

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(
                `Appeal ${result.label}`,
                `\`${caseCode}\` — ${result.record.name}\nDM to the user: ${result.dmDelivered ? 'delivered' : '**not delivered**'}.`
            )],
        });
    },
};
